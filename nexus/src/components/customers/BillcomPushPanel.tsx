"use client";

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { confirmInitialPush, previewInitialPush, runPendingPush } from "@/app/actions/billcomCustomers";
import type { PushPreview, PushResult } from "@/lib/billcom/customerPush";

export const RATE_LIMIT_WAIT_MS = 60_000;

export interface BillcomPushPanelHandle {
  /** Send waiting customers (used after a customer Sync). No-op if a run is active. */
  startPending(): void;
}

interface Props {
  pendingCount: number;
  ref?: Ref<BillcomPushPanelHandle>;
}

type RunState =
  | { kind: "idle" }
  | { kind: "loadingPreview" }
  | { kind: "preview"; preview: PushPreview }
  | { kind: "running"; sent: number; total: number; waiting: boolean }
  | { kind: "done"; total: number; failed: number; needsAttention: number }
  | { kind: "error"; message: string; retry?: Step };

type Step = "confirm" | "pending";

type Outcome = { ok: true; result: PushResult } | { ok: false; error: string };

const n = (x: number) => x.toLocaleString("en-US");
export const STALLED =
  "Sending stalled — Bill.com didn't accept any customers. Try again in a few minutes.";
const STALL_LIMIT = 2;
const processed = (r: PushResult) => r.created + r.updated + r.linked + r.unchanged + r.failed + r.needsAttention;

export function BillcomPushPanel({ pendingCount, ref }: Props) {
  const router = useRouter();
  const [state, setState] = useState<RunState>({ kind: "idle" });
  const active = useRef(false);
  const mounted = useRef(true);
  const stateRef = useRef<RunState>(state);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = (next: RunState) => {
    stateRef.current = next;
    setState(next);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  /** Run batches until nothing remains, the page closes, or the list can't be read. */
  async function run(step: Step) {
    if (active.current) return;
    active.current = true;
    let stalled = 0;
    let sent = 0;
    let total = 0;
    let failed = 0;
    let needsAttention = 0;
    let current: Step = step;
    try {
      while (mounted.current) {
        const res: Outcome = await (current === "confirm" ? confirmInitialPush() : runPendingPush());
        if (!mounted.current) return;
        if (!res.ok) {
          show({ kind: "error", message: res.error, retry: current });
          return;
        }
        const r = res.result;
        sent += processed(r);
        failed += r.failed;
        needsAttention += r.needsAttention;
        total = Math.max(total, sent + r.remaining);
        if (r.stoppedReason === "list_failed") {
          show({
            kind: "error",
            message: `Couldn't read the customer list from Bill.com. ${r.error ?? ""}`.trim(),
            retry: current,
          });
          return;
        }
        if (r.remaining <= 0) {
          show({ kind: "done", total, failed, needsAttention });
          router.refresh();
          return;
        }
        const waiting = r.stoppedReason === "rate_limit";
        stalled = processed(r) === 0 && !waiting ? stalled + 1 : 0;
        if (stalled >= STALL_LIMIT) {
          show({ kind: "error", message: STALLED, retry: "pending" });
          return;
        }
        show({ kind: "running", sent, total, waiting });
        if (waiting) {
          await new Promise<void>((resolve) => {
            timer.current = setTimeout(() => {
              timer.current = null;
              resolve();
            }, RATE_LIMIT_WAIT_MS);
          });
          if (!mounted.current) return;
          show({ kind: "running", sent, total, waiting: false });
        }
        current = "pending";
      }
    } catch (e) {
      if (mounted.current) {
        show({ kind: "error", message: e instanceof Error ? e.message : String(e), retry: current });
      }
    } finally {
      active.current = false;
    }
  }

  const begin = (step: Step) => {
    if (active.current) return;
    show({ kind: "running", sent: 0, total: step === "pending" ? pendingCount : 0, waiting: false });
    void run(step);
  };

  /** Only from a resting state: never over an open or loading preview, or a running batch. */
  const startPending = () => {
    const kind = stateRef.current.kind;
    if (kind === "idle" || kind === "done") begin("pending");
  };

  useImperativeHandle(ref, () => ({ startPending }));

  const openPreview = async () => {
    show({ kind: "loadingPreview" });
    const res = await previewInitialPush().catch((e: unknown) => ({
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    }));
    if (!mounted.current) return;
    show(res.ok ? { kind: "preview", preview: res.preview } : { kind: "error", message: res.error });
  };

  const confirm = () => begin("confirm");

  const busy = state.kind === "running" || state.kind === "loadingPreview";

  return (
    <div className="space-y-2 border-b border-border bg-surface px-5 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">Bill.com</span>
        <Button type="button" size="sm" variant="outline" disabled={busy || state.kind === "preview"} onClick={openPreview}>
          <Send className="size-4" />
          Push to Bill.com
        </Button>
        {pendingCount > 0 && (state.kind === "idle" || state.kind === "done") && (
          <Button type="button" size="sm" variant="outline" onClick={startPending}>
            Send {n(pendingCount)} waiting customer{pendingCount === 1 ? "" : "s"}
          </Button>
        )}
      </div>

      {state.kind === "loadingPreview" && <p className="text-foreground-muted">Checking what would change…</p>}

      {state.kind === "preview" && <PreviewView preview={state.preview} onConfirm={confirm} onCancel={() => show({ kind: "idle" })} />}

      {state.kind === "running" && (
        <p className="text-foreground-muted">
          <span>{state.total > 0 ? `Sent ${n(state.sent)} of ${n(state.total)}…` : "Sending customers to Bill.com…"}</span>
          {state.waiting && " Bill.com asked us to slow down, so we'll keep going in a minute."}
          {" "}Keep this page open until it finishes.
        </p>
      )}

      {state.kind === "done" && (
        <p className="text-foreground">
          All {n(state.total)} customer{state.total === 1 ? "" : "s"} sent to Bill.com.
          {state.failed > 0 && ` ${n(state.failed)} failed.`}
          {state.needsAttention > 0 && ` ${n(state.needsAttention)} need attention.`}
        </p>
      )}

      {state.kind === "error" && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-destructive">
          <span>{state.message}</span>
          {state.retry && (
            <Button type="button" size="sm" variant="outline" onClick={() => begin(state.retry!)}>
              Try again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(blank)";
  return String(v);
}

function PreviewView({ preview, onConfirm, onCancel }: { preview: PushPreview; onConfirm(): void; onCancel(): void }) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface-raised p-3">
      <p className="font-medium text-foreground">Here&apos;s what will happen. Nothing is sent until you confirm.</p>
      <ul className="list-disc pl-5 text-foreground-muted">
        <li>{n(preview.link)} will be linked to existing Bill.com customers</li>
        <li>{n(preview.create)} will be created in Bill.com</li>
        <li>{n(preview.update)} will be updated</li>
        <li>{n(preview.deactivate)} will be made inactive</li>
        <li>{n(preview.needsAttention.length)} need attention and won&apos;t be sent</li>
      </ul>
      {preview.needsAttention.length > 0 && (
        <div>
          <p className="font-medium text-foreground">Need attention</p>
          <ul className="pl-5 text-foreground-muted">
            {preview.needsAttention.map((a) => (
              <li key={a.number}>
                <span className="font-mono text-xs">{a.number}</span>: {a.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.sample.length > 0 && (
        <div>
          <p className="font-medium text-foreground">Example changes</p>
          <ul className="pl-5 text-foreground-muted">
            {preview.sample.slice(0, 10).map((s) => (
              <li key={s.number}>
                <span className="font-mono text-xs">{s.number}</span>
                <ul className="pl-4">
                  {Object.entries(s.changes).map(([field, [before, after]]) => (
                    <li key={field}>{`${field}: ${formatValue(before)} → ${formatValue(after)}`}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={onConfirm}>
          Confirm
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
