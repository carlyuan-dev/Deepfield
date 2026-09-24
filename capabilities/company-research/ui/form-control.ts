import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { CapabilityInteractionEditor } from "@deepfield/capability-sdk";

const plainObject = (value: any): value is Record<string, any> => value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function patchFields(patch: unknown, prefix = ""): Array<[string, unknown]> {
  return plainObject(patch) ? Object.entries(patch).flatMap(([key, value]) => patchFields(value, `${prefix}/${key}`)) : [[prefix, patch]];
}

export interface FormControl {
  values: any;
  remoteUpdate?: boolean;
  step?: string;
  edit(patch: unknown): void;
  flush(): Promise<void>;
  transition(step: string): Promise<void>;
  confirm(): Promise<void>;
  cancel(): Promise<void>;
}
export function scopeControl(control: FormControl | undefined, key: string): FormControl | undefined {
  return control && { ...control, values: control.values?.[key] ?? {}, edit: patch => control.edit({ [key]: patch }) };
}
/** One serialized writer for all existing company forms, bound to the originating interaction. */
export function useInteractionForm(editor: CapabilityInteractionEditor | undefined) {
  const [state, setState] = useState<Awaited<ReturnType<CapabilityInteractionEditor["read"]>>>();
  const [error, setError] = useState<string>();
  const [remoteUpdate, setRemoteUpdate] = useState(true);
  const pending = useRef(Promise.resolve());
  const unsynced = useRef(0);
  const acknowledged = useRef<number | undefined>(undefined);
  const lastOwnRevision = useRef(0);
  const generation = useRef(0);
  const responding = useRef(false);
  const ownLock = useRef<{ revision: number; draftRevision: string } | undefined>(undefined);
  const unsent = useRef<unknown[]>([]);
  const editEpoch = useRef(0);
  const conflicts = useRef(new Map<string, unknown>());
  const conflictMessage = () => `revision_changed：这些本地修改未同步：${JSON.stringify(Object.fromEntries(conflicts.current))}。请重新编辑冲突字段后确认。`;
  useEffect(() => {
    const token = ++generation.current;
    pending.current = Promise.resolve(); unsynced.current = 0; responding.current = false; lastOwnRevision.current = 0;
    ownLock.current = undefined; unsent.current = [];
    editEpoch.current++; conflicts.current.clear();
    setState(undefined); setError(undefined); acknowledged.current = undefined;
    if (!editor) return;
    let live = true;
    const refresh = () => { if (!unsynced.current) void editor.read().then(value => { if (live && token === generation.current && !unsynced.current) { acknowledged.current = value.revision; setRemoteUpdate(true); setState(value); } }).catch(() => { if (live && !responding.current) setError("表单已失效，请重新打开"); }); };
    refresh(); const unsubscribe = editor.subscribe(refresh);
    return () => { live = false; ++generation.current; unsubscribe(); };
  }, [editor]);
  const enqueue = (work: () => Promise<void>) => {
    const token = generation.current;
    unsynced.current++;
    pending.current = pending.current.catch(() => {}).then(work).catch(reason => {
      if (token === generation.current) {
        // No acquired lock means these edits never had a valid base. Preserve a
        // visible conflict, but never replay them against a later remote revision.
        if (!ownLock.current && unsent.current.length) {
          for (const patch of unsent.current) for (const [path, value] of patchFields(patch)) conflicts.current.set(path, value);
          unsent.current = []; editEpoch.current++;
        }
        setError(conflicts.current.size ? conflictMessage() : reason instanceof Error ? reason.message : "表单同步失败");
      }
      throw reason;
    }).finally(() => { if (token === generation.current) unsynced.current--; });
    void pending.current.catch(() => {});
  };
  const control: FormControl | undefined = editor && state ? {
    values: state.snapshot.values, remoteUpdate, ...(state.snapshot.step ? { step: state.snapshot.step } : {}),
    edit(patch) {
      const token = generation.current;
      const epoch = editEpoch.current;
      unsent.current.push(patch);
      // Start the lock in the input event, using precisely the displayed revision.
      const startingRevision = state.revision;
      const lock = unsynced.current === 0 && !ownLock.current ? editor.beginEdit(startingRevision) : undefined;
      if (unsynced.current === 0) pending.current = Promise.resolve();
      enqueue(async () => {
        if (token !== generation.current || epoch !== editEpoch.current) return;
        if (lock) {
          await lock;
          const acquired = await editor.read();
          if (token !== generation.current) return;
          if (acquired.status !== "editing" || acquired.revision !== startingRevision + 1) throw new Error("revision_changed");
          ownLock.current = { revision: acquired.revision, draftRevision: acquired.snapshot.draft.revision };
        } else if (!ownLock.current) {
          const expected = acknowledged.current!;
          await editor.beginEdit(expected);
          const acquired = await editor.read();
          if (token !== generation.current) return;
          if (acquired.status !== "editing" || acquired.revision !== expected + 1) throw new Error("revision_changed");
          ownLock.current = { revision: acquired.revision, draftRevision: acquired.snapshot.draft.revision };
        }
        // beginEdit changes the interaction revision; never update using the old one.
        const editing = await editor.read();
        if (token !== generation.current) return;
        if (editing.status !== "editing" || editing.revision !== ownLock.current?.revision || editing.snapshot.draft.revision !== ownLock.current.draftRevision) throw new Error("revision_changed");
        const count = unsent.current.length;
        const merge = (base: any, next: any): any => plainObject(next) ? Object.fromEntries([...new Set([...Object.keys(plainObject(base) ? base : {}), ...Object.keys(next)])].map(key => [key, key in next ? merge(plainObject(base) ? base[key] : undefined, next[key]) : base[key]])) : next;
        const combined = unsent.current.slice(0, count).reduce(merge, {});
        await editor.update(editing.revision, combined);
        if (token !== generation.current) return;
        ownLock.current = undefined;
        for (const [path] of patchFields(combined)) conflicts.current.delete(path);
        unsent.current.splice(0, count);
        const updated = await editor.read();
        if (token !== generation.current) return;
        acknowledged.current = updated.revision;
        lastOwnRevision.current = updated.revision;
        if (unsynced.current === 1) { setRemoteUpdate(false); setState(updated); }
        setError(conflicts.current.size ? conflictMessage() : undefined);
      });
    },
    async flush() { await pending.current; },
    async transition(step) { const token = generation.current; await pending.current; await editor.transition(Math.max(state.revision, lastOwnRevision.current), step); const updated = await editor.read(); if (token === generation.current) { acknowledged.current = updated.revision; lastOwnRevision.current = updated.revision; setRemoteUpdate(true); setState(updated); } },
    async confirm() {
      try { await pending.current; if (conflicts.current.size) throw new Error(conflictMessage()); responding.current = true; await editor.respond(Math.max(state.revision, lastOwnRevision.current), "approve"); }
      catch (reason) { responding.current = false; setError(reason instanceof Error ? reason.message : "确认失败，请刷新后重试"); throw reason; }
    },
    async cancel() {
      try { await pending.current.catch(() => {}); const current = await editor.read(); responding.current = true; await editor.respond(current.revision, "cancel"); }
      catch (reason) { responding.current = false; setError(reason instanceof Error ? reason.message : "取消失败，请重试"); }
    },
  } : undefined;
  return { state, control, error };
}

/** Native local editing stays synchronous; remote updates replace only this field after acknowledgment. */
export function useFormField<T>(control: FormControl | undefined, key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const remote = control?.values?.[key] as T | undefined;
  const [value, setValue] = useState<T>(remote ?? initial);
  const local = useRef(value);
  const serialized = JSON.stringify(remote);
  useEffect(() => { if (remote !== undefined && control?.remoteUpdate !== false) { local.current = remote; setValue(remote); } }, [serialized, control?.remoteUpdate]);
  return [value, next => {
    const updated = typeof next === "function" ? (next as (previous: T) => T)(local.current) : next;
    local.current = updated; setValue(updated); control?.edit({ [key]: updated });
  }];
}

export function useMappedFormField<T>(control: FormControl | undefined, key: string, initial: T, decode: (value: any) => T, encode: (value: T) => unknown) {
  const mapped = control && { ...control, values: { [key]: control.values?.[key] === undefined ? initial : decode(control.values[key]) }, edit: (patch: any) => control.edit({ [key]: encode(patch[key]) }) };
  return useFormField(mapped, key, initial);
}
