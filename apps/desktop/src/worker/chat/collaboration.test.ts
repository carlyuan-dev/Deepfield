import { describe, expect, it, vi } from 'vitest';
import * as budgets from './collaboration-budget.js';
import { createChatCollaborationSession } from './collaboration.js';
import { Agent } from '@earendil-works/pi-agent-core';
import { createFauxCore, type AssistantMessage, type FauxResponseStep, type Message } from '@earendil-works/pi-ai';
import type { AgentWorkerEvent, ChatCollaborationState } from '@deepfield/contracts';
import { createPiChatAgent, type PiRuntime } from '../agent/pi-chat-agent.js';
import { assistant, request } from '../agent/pi-chat-agent-test-helpers.js';
import { createToolRuntime } from '../tools/tool-runtime.js';
import { transcriptMessage } from './pi-session-transcript.js';
import { createMemoryContextTransform } from './memory-context.js';
import { createPiChatInteractionTools } from '../tools/pi-chat-interaction-tools.js';
import type { HostClient } from '../host-client.js';
function spawn(...titles:string[]):AssistantMessage{return assistant('',{content:titles.map((title,index)=>({type:'toolCall',id:`spawn-${index}`,name:'spawn_agent',arguments:{title,maxSearchCalls:0,instruction:`Produce ${title}`}})),stopReason:'toolUse'});}
function runtime(scripts:FauxResponseStep[][]){
  let sessions=0; const calls:Array<{systemPrompt:string;messages:Message[];tools:string[]}>=[];
  const runtime:PiRuntime={createSession(){const faux=createFauxCore({api:'openai-completions',provider:'deepfield-llm-1',tokensPerSecond:100000});faux.setResponses(scripts[sessions++]??[assistant('unexpected')]);return {model:faux.getModel(),streamFn:(model,context,options)=>{calls.push({systemPrompt:context.systemPrompt??'',messages:structuredClone(context.messages),tools:(context.tools??[]).map(tool=>tool.name)});return faux.streamSimple(model,context,options);}};},createAgent:options=>new Agent(options)};
  return {runtime,calls,get sessions(){return sessions;}};
}
function setup(scripts:FauxResponseStep[][],rejectCheckpoint:boolean|((state:ChatCollaborationState)=>boolean)=false,memory?:{enabled:boolean;disableOnDispatch?:boolean}){
  const f=runtime(scripts);const states:ChatCollaborationState[]=[];const audits:string[]=[];
  const tools=createToolRuntime({audit:{start:async record=>{audits.push(record.tool.name);},finish:async()=>{}}});
  const host:Pick<HostClient,'request'>={request:async(method,payload)=>{if(method==='chat.collaboration'){const state=(payload as {state:ChatCollaborationState}).state;if(typeof rejectCheckpoint==='function'?rejectCheckpoint(state):rejectCheckpoint)throw new Error('durability unavailable');states.push(structuredClone(state));if(memory?.disableOnDispatch&&state.tasks.length)memory.enabled=false;return {saved:true};}if(method==='chat.interaction')return {result:{status:'waiting'}};if(method==='memory.call')return {result:{status:'ok',useEnabled:memory?.enabled??true,validRefs:memory?.enabled?(payload as {command:{refs:unknown[]}}).command.refs:[]}};throw new Error('unexpected host method');}};
  const agent=createPiChatAgent(f.runtime,[],undefined,{},tools,undefined,undefined,'main_agent',undefined,(request,handoff)=>createPiChatInteractionTools(request,host,handoff),memory?(request,actor)=>createMemoryContextTransform(request,host,actor):undefined,{host,tools});
  return {f,states,audits,agent};
}
describe('Chat collaboration through installed Pi',()=>{
  it('explains an unavailable prior-turn task without replaying it or claiming executor failure',async()=>{
    const x=setup([[assistant('',{content:[{type:'toolCall',id:'old-task',name:'followup_agent',arguments:{taskId:'previous-request-task',instruction:'Review the existing result'}}],stopReason:'toolUse'}),context=>{
      const reply=context.messages.findLast(message=>message.role==='toolResult');
      expect(JSON.stringify(reply)).toContain('task_not_in_current_request');
      expect(JSON.stringify(reply)).not.toContain('executor_failed');
      return assistant('Use saved results to start a fresh review');
    }]]);
    await x.agent.run(request(),()=>{},new AbortController().signal);
    expect(x.f.sessions).toBe(1);expect(x.states).toEqual([]);
  });

  it('guides a late message to follow-up without restarting the completed child',async()=>{
    const x=setup([[spawn('alpha'),async()=>{
      await vi.waitFor(()=>expect(x.states.some(state=>state.tasks[0]?.status==='completed')).toBe(true));
      return assistant('',{content:[{type:'toolCall',id:'late-send',name:'send_agent_message',arguments:{taskId:x.states.at(-1)!.tasks[0]!.taskId,message:'Review'}}],stopReason:'toolUse'});
    },context=>{
      const reply=context.messages.findLast(message=>message.role==='toolResult');
      expect(JSON.stringify(reply)).toContain('followup_agent');
      expect(JSON.stringify(reply)).not.toContain('executor_failed');
      return assistant('Child completed; review requires follow-up');
    }],[assistant('Child result')],[assistant('Child result retained')]]);
    await x.agent.run(request(),()=>{},new AbortController().signal);
    expect(JSON.parse(x.states.at(-1)!.snapshot).tasks[0].runs).toHaveLength(1);
  });

  it('joins independent child results through an internal continuation and publishes one final completion',async()=>{
    const x=setup([[spawn('alpha','beta'),assistant('Temporary parent reply')],[assistant('alpha result')],[assistant('beta result')],[assistant('Combined alpha and beta')]]);
    const events:AgentWorkerEvent[]=[];const r=request();r.context.messages.push({role:'user',content:'parent-private-history',timestamp:3});
    await x.agent.run(r,event=>events.push(event),new AbortController().signal);
    expect(events.filter(event=>event.type==='completed')).toEqual([{requestId:r.requestId,type:'completed',text:'Combined alpha and beta'}]);
    expect(x.audits.filter(name=>name==='spawn_agent')).toHaveLength(2);
    const childCalls=x.f.calls.filter(call=>call.systemPrompt.includes('独立子任务'));
    expect(childCalls).toHaveLength(2);
    for(const call of childCalls){expect(JSON.stringify(call.messages)).not.toContain('parent-private-history');expect(call.tools).not.toContain('spawn_agent');expect(call.systemPrompt).not.toContain('协作执行要求');expect(call.systemPrompt).not.toContain('必须复用原 taskId');}
    const last=x.f.calls.at(-1)!;expect(JSON.stringify(last.messages)).toContain('alpha result');expect(JSON.stringify(last.messages)).toContain('beta result');
    expect(x.states.at(-1)?.status).toBe('completed');expect(x.states.at(-1)?.tasks.every(task=>task.status==='completed')).toBe(true);
    expect(events.filter(event=>event.type==='agent_tasks').length).toBeGreaterThan(0);
  });

  it('does not start a child or advertise success when dispatch persistence fails',async()=>{
    const x=setup([[spawn('alpha'),assistant('Must not become final')]],true);const events:AgentWorkerEvent[]=[];
    await expect(x.agent.run(request(),event=>events.push(event),new AbortController().signal)).rejects.toThrow();
    expect(x.f.sessions).toBe(1);expect(events.some(event=>event.type==='completed')).toBe(false);expect(events.some(event=>event.type==='agent_tasks')).toBe(false);
  });

  it('keeps ordinary requests on one existing execution without collaboration persistence',async()=>{
    const x=setup([[assistant('ordinary answer')]]);const events:AgentWorkerEvent[]=[];
    await x.agent.run(request(),event=>events.push(event),new AbortController().signal);
    expect(x.f.sessions).toBe(1);expect(x.states).toEqual([]);expect(events.filter(event=>event.type==='completed')).toHaveLength(1);
  });
  it('delivers running messages only when Pi incorporates them at a safe boundary',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    const x=setup([
      [spawn('alpha'),context=>{const receipt=context.messages.findLast(message=>message.role==='toolResult');const task=JSON.parse((receipt as {content:{text:string}[]}).content[0]!.text);return assistant('',{content:[{type:'toolCall',id:'send',name:'send_agent_message',arguments:{taskId:task.taskId,message:'Add verification'}}],stopReason:'toolUse'});},()=>{release();return assistant('Temporary');}],
      [async()=>{await gate;return assistant('Initial child draft');},context=>{expect(JSON.stringify(context.messages)).toContain('Add verification');return assistant('Verified child result');}],
      [assistant('Verified merged answer')],
    ]);
    const events:AgentWorkerEvent[]=[];await x.agent.run(request(),event=>events.push(event),new AbortController().signal);
    const snapshot=JSON.parse(x.states.at(-1)!.snapshot);
    expect(snapshot.tasks[0].runs[0].messages[0].status).toBe('delivered');
    expect(events.filter(event=>event.type==='completed')).toEqual([{requestId:'req-1',type:'completed',text:'Verified merged answer'}]);
  });

  it('settles children before HITL and restores committed results without restarting them, with a tool-free reserved final turn',async()=>{
    const x=setup([
      [spawn('finished','unfinished'),async context=>{await vi.waitFor(()=>expect(x.states.some(state=>state.tasks.some(task=>task.title==='finished'&&task.status==='completed'))).toBe(true));const first=context.messages.find(message=>message.role==='toolResult'&&message.toolName==='spawn_agent');const ref=JSON.parse((first as {content:{text:string}[]}).content[0]!.text);return assistant('',{content:[{type:'toolCall',id:'wait-finished',name:'wait_agents',arguments:{runIds:[ref.runId],cursor:0,timeoutMs:30000}}],stopReason:'toolUse'});},assistant('',{content:[{type:'toolCall',id:'question',name:'request_user_input',arguments:{question:'Choose the next step'}}],stopReason:'toolUse'})],
      [assistant('Existing committed result')],
      [async(_context,options)=>{if(!options?.signal?.aborted)await new Promise<void>(resolve=>options?.signal?.addEventListener('abort',()=>resolve(),{once:true}));return assistant('Late child output');}],
    ]);
    const events:AgentWorkerEvent[]=[];await x.agent.run(request(),event=>events.push(event),new AbortController().signal);
    expect(events.filter(event=>event.type==='handed_off')).toHaveLength(1);
    const state=x.states.at(-1)!;expect(state.status).toBe('waiting_user');expect(state.tasks.every(task=>['completed','cancelled'].includes(task.status))).toBe(true);
    const resumed=setup([[assistant('Used the committed result')]]);const r=request();r.requestId='resumed';r.prompt='Continue using the completed work';r.context.collaboration={...state,modelCalls:31};
    await resumed.agent.run(r,()=>{},new AbortController().signal);
    expect(resumed.f.sessions).toBe(1);expect(resumed.f.calls[0]!.tools).toEqual([]);
    expect(JSON.stringify(resumed.f.calls[0]!.messages)).toContain('Existing committed result');
    expect(resumed.states.at(-1)?.modelCalls).toBe(31);
  });

  it('returns the deterministic timeout outcome when the hard deadline interrupts a child wait',async()=>{
    const deadline=new AbortController();const actualBudget=budgets.createCollaborationBudget();
    const spy=vi.spyOn(budgets,'createCollaborationBudget').mockReturnValue({...actualBudget,signal:deadline.signal});
    const tools=createToolRuntime({audit:{start:async()=>{},finish:async()=>{}}});
    const states:ChatCollaborationState[]=[];const events:AgentWorkerEvent[]=[];let parentStopped=false;
    const host:Pick<HostClient,'request'>={request:async(_method,payload)=>{states.push(structuredClone((payload as {state:ChatCollaborationState}).state));return {saved:true};}};
    try{
      const session=createChatCollaborationSession(request(),event=>events.push(event),new AbortController().signal,{host,tools},async(r,emit,signal,turn)=>{
        if(turn.actor==='child_agent'){await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));return [];}
        await turn.tools.find(tool=>tool.name==='spawn_agent')!.execute('spawn',{title:'Pending child',maxSearchCalls:0,instruction:'Wait for result'},signal);
        emit({requestId:r.requestId,type:'completed',text:'Temporary'});parentStopped=true;return [];
      });
      const run=session.run();await vi.waitFor(()=>expect(parentStopped).toBe(true));
      expect(events.some(event=>event.type==='completed')).toBe(false);deadline.abort();await run;
      const completion=events.find(event=>event.type==='completed');expect(completion?.type==='completed'&&completion.text).toContain('执行时间上限');
      expect(states.at(-1)?.status).toBe('interrupted');expect(states.at(-1)?.tasks.every(task=>!['queued','running','cancelling'].includes(task.status))).toBe(true);
    }finally{spy.mockRestore();actualBudget.close();}
  });

  it.each(['list_agents','read_agent_result'] as const)('accounts for %s coverage without replaying an already consumed full result',async toolName=>{
    const childText='x'.repeat(19000)+'RESULT-END';
    const x=setup([
      [spawn('alpha'),async context=>{await vi.waitFor(()=>expect(x.states.some(state=>state.tasks.some(task=>task.status==='completed'))).toBe(true),{timeout:4000});const result=context.messages.find(message=>message.role==='toolResult'&&message.toolName==='spawn_agent');const ref=JSON.parse((result as {content:{text:string}[]}).content[0]!.text);return assistant('',{content:[{type:'toolCall',id:'read',name:toolName,arguments:toolName==='list_agents'?{}:{taskId:ref.taskId,runId:ref.runId}}],stopReason:'toolUse'});},assistant('Answered using the result')],
      [assistant(childText)],
      [assistant('Answered using the complete result')],
    ]);
    const events:AgentWorkerEvent[]=[];await x.agent.run(request(),event=>events.push(event),new AbortController().signal);
    expect(x.f.sessions).toBe(toolName==='list_agents'?2:3);
    if(toolName==='read_agent_result')expect(JSON.stringify(x.f.calls.at(-1)!.messages)).toContain('RESULT-END');
    expect(events.filter(event=>event.type==='completed')).toHaveLength(1);
    expect(x.states.at(-1)?.deliveredRunIds).toHaveLength(1);
  });

  it('keeps committed results pending when the internal model continuation fails',async()=>{
    const x=setup([[spawn('alpha'),assistant('Temporary')],[assistant('Committed result')],[assistant('',{stopReason:'error'})]]);
    await expect(x.agent.run(request(),()=>{},new AbortController().signal)).rejects.toThrow();
    expect(x.states.at(-1)?.resultCursor).toBe(0);expect(x.states.at(-1)?.deliveredRunIds).toEqual([]);
    expect(x.states.at(-1)?.tasks[0]?.result).toBe('Committed result');
  });

  it('removes invalid Memory-derived dispatch, child result, tool result and fallback final text from actual model inputs',async()=>{
    const secret='MEMORY-DERIVED-PRIVATE-CONTENT';const memory={enabled:true,disableOnDispatch:true};
    const x=setup([
      [assistant('',{content:[{type:'toolCall',id:'spawn-secret',name:'spawn_agent',arguments:{title:'alpha',maxSearchCalls:0,instruction:secret,context:secret}}],stopReason:'toolUse'}),async()=>{await vi.waitFor(()=>expect(x.states.some(state=>state.tasks.some(task=>task.status==='completed'))).toBe(true),{timeout:4000});return assistant('',{content:[{type:'toolCall',id:'list-secret',name:'list_agents',arguments:{}}],stopReason:'toolUse'});},assistant(secret)],
      [assistant(secret)],
      [assistant('Using current data only')],
      [assistant('Legacy data omitted')],
    ],false,memory);
    const r=request();r.context.memory={entries:[{id:'memory-1',revision:1,summary:secret,content:secret,applicability:'current',scope:'user',origin:'user'}],state:'ready'};
    const events:AgentWorkerEvent[]=[];await x.agent.run(r,event=>events.push(event),new AbortController().signal);
    expect(JSON.stringify(x.f.calls[0]!.messages)).toContain(secret);
    for(const call of x.f.calls.slice(1))expect(JSON.stringify(call.messages)).not.toContain(secret);
    expect(x.states.at(-1)?.memoryDependencies).toEqual(expect.objectContaining({[x.states.at(-1)!.tasks[0]!.runId]:[{id:'memory-1',revision:1}]}));
    const checkpoint=events.findLast(event=>event.type==='transcript_checkpoint');if(checkpoint?.type!=='transcript_checkpoint')throw new Error('Missing safe transcript');
    const next=request();next.requestId='fresh-request';next.prompt='Use current information';next.context.memory={entries:[],state:'disabled'};
    next.context.messages=[{role:'user',content:r.prompt,timestamp:1,requestId:r.requestId},{role:'assistant',content:secret,timestamp:2,requestId:r.requestId}];
    next.context.historyTurns=[{requestId:r.requestId,network:'disabled',messages:checkpoint.messages}];
    await x.agent.run(next,()=>{},new AbortController().signal);
    expect(JSON.stringify(x.f.calls.at(-1)!.messages)).not.toContain(secret);
    expect(JSON.stringify(x.f.calls.at(-1)!.messages)).toContain('材料已省略');
    const legacy={...next,requestId:'legacy-request',context:{...next.context,historyTurns:[{requestId:r.requestId,network:'disabled' as const,messages:checkpoint.messages.map(message=>{const {memoryDependencies:_refs,...untagged}=message;return untagged;})}]}};
    await x.agent.run(legacy,()=>{},new AbortController().signal);
    expect(JSON.stringify(x.f.calls.at(-1)!.messages)).not.toContain(secret);
    expect(JSON.stringify(x.f.calls.at(-1)!.messages)).toContain('材料已省略');
  });

  it('fails an unsettled HITL handoff after persisting interrupted, without advertising a normal handoff',async()=>{
    vi.useFakeTimers();
    const states:ChatCollaborationState[]=[];const events:AgentWorkerEvent[]=[];
    const tools=createToolRuntime({audit:{start:async()=>{},finish:async()=>{}}});
    const host:Pick<HostClient,'request'>={request:async(_method,payload)=>{states.push(structuredClone((payload as {state:ChatCollaborationState}).state));return {saved:true};}};
    try{
      const session=createChatCollaborationSession(request(),event=>events.push(event),new AbortController().signal,{host,tools},async(r,emit,signal,turn)=>{
        if(turn.actor==='child_agent')await new Promise(()=>{});
        else{await turn.tools.find(tool=>tool.name==='spawn_agent')!.execute('spawn',{title:'Uncooperative',maxSearchCalls:0,instruction:'Remain active'},signal);emit({requestId:r.requestId,type:'handed_off'});}return [];
      });
      const run=session.run().then(()=>undefined,error=>error);await vi.advanceTimersByTimeAsync(2100);
      expect((await run)?.message).toBe('collaboration_handoff_unsettled');expect(states.at(-1)?.status).toBe('interrupted');
      expect(events.some(event=>event.type==='handed_off')).toBe(false);
    }finally{vi.useRealTimers();}
  });

  it('does not advertise a handoff when its durable waiting checkpoint fails',async()=>{
    const x=setup([[spawn('alpha'),async()=>{await vi.waitFor(()=>expect(x.states.some(state=>state.tasks.some(task=>task.status==='completed'))).toBe(true),{timeout:4000});return assistant('',{content:[{type:'toolCall',id:'question-failed-save',name:'request_user_input',arguments:{question:'Choose next'}}],stopReason:'toolUse'});}],[assistant('Committed')]],state=>state.status==='waiting_user');
    const events:AgentWorkerEvent[]=[];await expect(x.agent.run(request(),event=>events.push(event),new AbortController().signal)).rejects.toThrow();
    expect(events.some(event=>event.type==='handed_off')).toBe(false);expect(x.states.some(state=>state.status==='waiting_user')).toBe(false);
  });

  it.each(['model','wait'] as const)('cancels the %s phase at the soft deadline and keeps the hard signal available for the final answer',async phase=>{
    const actual=budgets.createCollaborationBudget();const soft=new AbortController();
    const spy=vi.spyOn(budgets,'createCollaborationBudget').mockReturnValue({...actual,workSignal:soft.signal,get shouldFinalize(){return soft.signal.aborted;}});
    const tools=createToolRuntime({audit:{start:async()=>{},finish:async()=>{}}});const events:AgentWorkerEvent[]=[];let working=false,childStarted=false,finals=0;
    const host:Pick<HostClient,'request'>={request:async()=>({saved:true})};
    try{
      const session=createChatCollaborationSession(request(),event=>events.push(event),new AbortController().signal,{host,tools},async(r,emit,signal,turn)=>{
        if(turn.actor==='child_agent'){childStarted=true;await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));return [];}
        if(!turn.tools.length){finals++;expect(signal.aborted).toBe(false);expect(r.toolAccess.maxAgentTurns).toBe(1);emit({requestId:r.requestId,type:'completed',text:'Final answer from saved work'});return [];}
        await turn.tools.find(tool=>tool.name==='spawn_agent')!.execute('spawn',{title:'Active work',maxSearchCalls:0,instruction:'Work until stopped'},signal);
        working=true;if(phase==='wait'){emit({requestId:r.requestId,type:'completed',text:'Temporary waiting reply'});tools.releaseTrace(r.requestId);return [];}await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));tools.releaseTrace(r.requestId);throw new Error('work phase stopped');
      });
      const run=session.run();await vi.waitFor(()=>expect(working&&childStarted).toBe(true));soft.abort();await run;
      expect(finals).toBe(1);expect(actual.signal.aborted).toBe(false);expect(events.filter(event=>event.type==='completed')).toEqual([{requestId:'req-1',type:'completed',text:'Final answer from saved work'}]);
    }finally{spy.mockRestore();actual.close();}
  });

  it('keeps Memory dependencies through a trusted restart and follow-up history',async()=>{
    const secret='OLD-CHILD-MEMORY-MATERIAL';const memory={enabled:true};
    const original=setup([
      [assistant('',{content:[{type:'toolCall',id:'spawn-old',name:'spawn_agent',arguments:{title:'alpha',maxSearchCalls:0,instruction:secret}}],stopReason:'toolUse'}),async()=>{await vi.waitFor(()=>expect(original.states.some(state=>state.tasks.some(task=>task.status==='completed'))).toBe(true));return assistant('',{content:[{type:'toolCall',id:'question-old',name:'request_user_input',arguments:{question:'Continue later?'}}],stopReason:'toolUse'});}],
      [assistant(secret)],
    ],false,memory);
    const input=request();input.context.memory={entries:[{id:'memory-1',revision:1,summary:secret,content:secret,applicability:'current',scope:'user',origin:'user'}],state:'ready'};
    await original.agent.run(input,()=>{},new AbortController().signal);const state=original.states.at(-1)!;expect(state.status).toBe('waiting_user');
    const oldTask=state.tasks[0]!;memory.enabled=false;
    const resumed=setup([
      [assistant('',{content:[{type:'toolCall',id:'followup-current',name:'followup_agent',arguments:{taskId:oldTask.taskId,instruction:'Use only current information'}}],stopReason:'toolUse'}),async()=>{await vi.waitFor(()=>expect(resumed.states.some(saved=>saved.tasks.some(task=>task.sequence===2&&task.status==='completed'))).toBe(true));return assistant('',{content:[{type:'toolCall',id:'list-current',name:'list_agents',arguments:{}}],stopReason:'toolUse'});},assistant('Current information only')],
      [assistant('Current child result')],
    ],false,memory);
    const next=request();next.requestId='restart-followup';next.prompt='Continue';next.context.collaboration=state;next.context.memory={entries:[],state:'disabled'};
    await resumed.agent.run(next,()=>{},new AbortController().signal);
    const childCalls=resumed.f.calls.filter(call=>call.systemPrompt.includes('独立子任务'));expect(childCalls).toHaveLength(1);
    for(const call of resumed.f.calls)expect(JSON.stringify(call.messages)).not.toContain(secret);
    const latest=resumed.states.at(-1)!;expect(latest.tasks[0]!.sequence).toBe(2);expect(latest.memoryDependencies?.[latest.tasks[0]!.runId]).toEqual([{id:'memory-1',revision:1}]);
  });

  it('propagates an un-recalled historical input dependency into new output and delegated material',async()=>{
    const marker='VALID-HISTORY-NOT-IN-CURRENT-DIRECTORY';const refs=[{id:'history-memory',revision:1}];const memory={enabled:true};
    const x=setup([
      [assistant('',{content:[{type:'toolCall',id:'history-spawn',name:'spawn_agent',arguments:{title:'Use prior context',maxSearchCalls:0,instruction:marker}}],stopReason:'toolUse'}),async()=>{await vi.waitFor(()=>expect(x.states.some(state=>state.tasks.some(task=>task.status==='completed'))).toBe(true));return assistant('',{content:[{type:'toolCall',id:'history-list',name:'list_agents',arguments:{}}],stopReason:'toolUse'});},assistant(marker)],
      [assistant(marker)],
      [assistant('Current input only')],
    ],false,memory);
    const r=request();r.context.memory={entries:[],state:'empty'};r.context.messages=[{role:'assistant',content:marker,timestamp:1,requestId:'historical'}];
    r.context.historyTurns=[{requestId:'historical',network:'disabled',messages:[{...transcriptMessage(assistant(marker))!,memoryDependencies:refs}]}];
    const events:AgentWorkerEvent[]=[];await x.agent.run(r,event=>events.push(event),new AbortController().signal);
    expect(JSON.stringify(x.f.calls[0]!.messages)).toContain(marker);
    const checkpoint=events.findLast(event=>event.type==='transcript_checkpoint');if(checkpoint?.type!=='transcript_checkpoint')throw new Error('Missing checkpoint');
    memory.enabled=false;const next=request();next.requestId='after-history-disabled';next.context.memory={entries:[],state:'disabled'};next.context.messages=[{role:'assistant',content:marker,timestamp:1,requestId:r.requestId}];next.context.historyTurns=[{requestId:r.requestId,network:'disabled',messages:checkpoint.messages}];
    await x.agent.run(next,()=>{},new AbortController().signal);
    expect(JSON.stringify(x.f.calls.at(-1)!.messages)).not.toContain(marker);
    const state=x.states.at(-1)!;expect(state.memoryDependencies?.[state.tasks[0]!.runId]).toEqual(refs);
  });

  it('inherits actual child historical dependencies when the stored run map did not recall them',async()=>{
    const marker='CHILD-INPUT-DEPENDENCY-OUTSIDE-DIRECTORY';const refs=[{id:'child-memory',revision:1}];const memory={enabled:true};
    const old=setup([[spawn('alpha'),assistant('Temporary')],[assistant(marker)],[assistant('Merged result')]],false,memory);
    const initial=request();initial.context.memory={entries:[{...refs[0]!,summary:marker,content:marker,applicability:'current',scope:'user',origin:'user'}],state:'ready'};
    await old.agent.run(initial,()=>{},new AbortController().signal);const saved=structuredClone(old.states.at(-1)!);const oldTask=saved.tasks[0]!;
    // A prior checkpoint retained the safe transcript ref, but its run map missed that inherited input.
    saved.status='waiting_user';saved.memoryDependencies={[oldTask.runId]:[]};
    const x=setup([
      [assistant('',{content:[{type:'toolCall',id:'child-history-follow',name:'followup_agent',arguments:{taskId:oldTask.taskId,instruction:'Continue from the prior task history'}}],stopReason:'toolUse'}),async()=>{await vi.waitFor(()=>expect(x.states.some(state=>state.tasks.some(task=>task.sequence===2&&task.status==='completed'))).toBe(true));return assistant('',{content:[{type:'toolCall',id:'child-history-list',name:'list_agents',arguments:{}}],stopReason:'toolUse'});},assistant(marker)],
      [assistant(marker)],
      [assistant('No stale material')],
    ],false,memory);
    const resumed=request();resumed.requestId='child-history-resumed';resumed.context.collaboration=saved;resumed.context.memory={entries:[],state:'empty'};
    const events:AgentWorkerEvent[]=[];await x.agent.run(resumed,event=>events.push(event),new AbortController().signal);
    expect(JSON.stringify(x.f.calls.find(call=>call.systemPrompt.includes('独立子任务'))!.messages)).toContain(marker);
    const checkpoint=events.findLast(event=>event.type==='transcript_checkpoint');if(checkpoint?.type!=='transcript_checkpoint')throw new Error('Missing checkpoint');
    memory.enabled=false;const next=request();next.requestId='child-history-disabled';next.context.memory={entries:[],state:'disabled'};next.context.messages=[{role:'assistant',content:marker,timestamp:1,requestId:resumed.requestId}];next.context.historyTurns=[{requestId:resumed.requestId,network:'disabled',messages:checkpoint.messages}];
    await x.agent.run(next,()=>{},new AbortController().signal);
    expect(JSON.stringify(x.f.calls.at(-1)!.messages)).not.toContain(marker);
    const state=x.states.at(-1)!;expect(state.memoryDependencies?.[state.tasks[0]!.runId]).toEqual(refs);
  });

  it('omits untracked legacy Compact summary and retained collaboration material without history turns',async()=>{
    const marker='LEGACY-COMPACT-RETAINED-MEMORY';const x=setup([[assistant('Only current input')]],false,{enabled:false});const r=request();
    r.context.memory={entries:[],state:'disabled'};r.context.messages=[];r.context.historyTurns=[];
    r.context.compaction={summary:marker,retainedMessages:[transcriptMessage(assistant('',{content:[{type:'toolCall',id:'legacy-read',name:'read_agent_result',arguments:{taskId:'old',runId:'old-run'}}],stopReason:'toolUse'}))!,{role:'toolResult',toolName:'read_agent_result',toolCallId:'legacy-read',isError:false,content:[{type:'text',text:marker}],timestamp:1}],sourceMessageCount:0,createdAt:1,tokensBefore:100,tokensAfter:10};
    await x.agent.run(r,()=>{},new AbortController().signal);
    expect(JSON.stringify(x.f.calls[0]!.messages)).not.toContain(marker);
  });

});

describe('committed child evidence delivery',()=>{
  it.each(['automatic','list'] as const)('preserves source URLs and dated facts through %s delivery without replay',async mode=>{
    const source={url:'https://example.org/releases/2026-10-17',title:'Official release'};
    const fact='Product Alpha was released on 2026-10-17.';
    const tools=createToolRuntime({audit:{start:async()=>{},finish:async()=>{}}});
    const host:Pick<HostClient,'request'>={request:async()=>({saved:true})};
    let roots=0;
    const session=createChatCollaborationSession(request(),()=>{},new AbortController().signal,{host,tools},async(r,emit,signal,turn)=>{
      if(turn.actor==='child_agent'){
        emit({type:'tool_activity',requestId:r.requestId,callKey:'source-read',name:'read_webpage',status:'completed',sources:[source]});
        emit({type:'completed',requestId:r.requestId,text:fact});return [];
      }
      roots++;
      if(roots===1){
        await turn.tools.find(tool=>tool.name==='spawn_agent')!.execute('spawn-evidence',{title:'Release',maxSearchCalls:0,instruction:'Read official release'},signal);
        await vi.waitFor(()=>expect(session.coordinator.list()[0]?.runs[0]?.status).toBe('completed'));
        if(mode==='list'){
          const result=await turn.tools.find(tool=>tool.name==='list_agents')!.execute('list-evidence',{},signal);
          const payload=JSON.parse((result.content[0] as {text:string}).text);
          expect(payload.tasks[0]).toMatchObject({result:fact,sources:[source]});
          await turn.onMessage?.({role:'toolResult',toolName:'list_agents',toolCallId:'list-evidence',content:result.content,details:result.details,isError:false,timestamp:Date.now()},[]);
        }
      }else{
        const delivered=JSON.stringify(turn.contextMessages);
        expect(delivered).toContain(fact);expect(delivered).toContain(source.url);expect(delivered).toContain(source.title);
      }
      tools.releaseTrace(r.requestId); // The real executor releases its per-turn trace before continuation.
      emit({type:'completed',requestId:r.requestId,text:'Answer'});return [];
    });
    await session.run();
    expect(roots).toBe(mode==='list'?1:2);
  });
});

it('passes declared child search limits to execution and clamps them to the parent ceiling', async () => {
  const input=request();input.toolAccess.maxSearchCalls=3;
  const tools=createToolRuntime({audit:{start:async()=>{},finish:async()=>{}}});
  const limits:number[]=[];let spawned=false;
  const session=createChatCollaborationSession(input,()=>{},new AbortController().signal,{host:{request:async()=>({saved:true})},tools},async(r,emit,signal,turn)=>{
    if(turn.actor==='child_agent'){limits.push(turn.maxSearchCalls!);emit({type:'completed',requestId:r.requestId,text:'Read-only task complete'});return [];}
    if(!spawned){spawned=true;for(const limit of [2,50])await turn.tools.find(tool=>tool.name==='spawn_agent')!.execute(`spawn-${limit}`,{title:`Task ${limit}`,instruction:'Read only',maxSearchCalls:limit},signal);await vi.waitFor(()=>expect(limits).toHaveLength(2));}
    tools.releaseTrace(r.requestId);emit({type:'completed',requestId:r.requestId,text:'Done'});return [];
  });
  await session.run();expect(limits.sort()).toEqual([2,3]);
});
