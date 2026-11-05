// Offline, explicitly synthetic public data for the local Phoenix UI smoke.
// This fixture never calls a provider and never represents an observed model run.
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const directory = process.argv[2];
if (!directory || process.argv.length !== 3) throw Error('fixture_output_directory_required');
const output = resolve(directory);
mkdirSync(output, { mode: 0o700 }); // Existing artifacts cannot be overwritten.
const root = 'public-synthetic-content-v1', request = 'public-synthetic-request-v1';
const tracePath = join(output, 'trace.sqlite'), contentPath = join(output, 'content.sqlite');
const trace = new DatabaseSync(tracePath), content = new DatabaseSync(contentPath);
try {
  trace.exec('CREATE TABLE trace_events(event_id TEXT PRIMARY KEY,root_id TEXT,span_id TEXT,type TEXT,kind TEXT,time TEXT,payload TEXT,truncated_end INTEGER DEFAULT 0);CREATE TABLE trace_sessions(session_id TEXT PRIMARY KEY,interrupted INTEGER);CREATE TABLE trace_health(source TEXT PRIMARY KEY,payload TEXT);PRAGMA user_version=2;');
  trace.prepare('INSERT INTO trace_sessions VALUES(?,0)').run('synthetic-session');
  let sequence = 0;
  for (const [spanId, kind] of [['root','request'],['model','model'],['tool-truncated','tool'],['tool-unavailable','tool']]) {
    for (const type of ['span.start','span.end']) {
      const event = { version:1,eventId:`${spanId}-${type}`,rootTraceId:root,spanId,requestId:request,processSessionId:'synthetic-session',sequence:++sequence,
        time:type==='span.start'?'2026-10-22T00:00:00.000Z':'2026-10-22T00:00:01.000Z',type,kind,
        ...(spanId==='root'?{}:{parentSpanId:'root'}),...(type==='span.end'?{status:'succeeded'}:{}) };
      trace.prepare('INSERT INTO trace_events(event_id,root_id,span_id,type,kind,time,payload) VALUES(?,?,?,?,?,?,?)').run(event.eventId,root,spanId,type,kind,event.time,JSON.stringify(event));
    }
  }
  content.exec('CREATE TABLE content(id TEXT PRIMARY KEY,root_id TEXT,captured_at INTEGER,payload TEXT);PRAGMA user_version=1;');
  const rows = [
    { spanId:'model',kind:'model.request',source:'provider.http_json',body:{messages:[{role:'user',content:'公开合成测试：请确认本地目录已读取。'}]},completeness:'complete',reasonCode:'none' },
    { spanId:'model',kind:'model.response',source:'pi.assistant_message',body:{content:[{type:'thinking',thinking:'synthetic-private-block-must-not-export'},{type:'text',text:'公开合成测试：本地目录已读取。'}],stopReason:'stop'},completeness:'complete',reasonCode:'none' },
    { spanId:'tool-truncated',kind:'tool.output',source:'tool.executor',body:'{"synthetic_prefix":',completeness:'truncated',reasonCode:'size_limit' },
    { spanId:'tool-unavailable',kind:'tool.output',source:'tool.executor',completeness:'unavailable',reasonCode:'serialization_failed' },
  ];
  for (const [index, row] of rows.entries()) {
    const record = {version:1,contentId:`synthetic-content-${index}`,rootTraceId:root,requestId:request,capturedAt:'2026-10-22T00:00:01.000Z',captureMode:'benchmark',redacted:false,
      ...row,byteLength:row.body===undefined?0:Buffer.byteLength(JSON.stringify(row.body))};
    content.prepare('INSERT INTO content VALUES(?,?,?,?)').run(record.contentId,root,1792627201000,JSON.stringify(record));
  }
} finally { trace.close(); content.close(); chmodSync(tracePath,0o600); chmodSync(contentPath,0o600); }
console.log(JSON.stringify({source:'synthetic_public_fixture',output,rootTraceId:root,records:4,providerCalls:0}));
