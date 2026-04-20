import { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Mic, Square, Trash2, Check } from "lucide-react";

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AudioRecorderPopover({
  onRecorded,
}: {
  onRecorded: (file: File) => void;
}) {
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const openRef = useRef(false);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const reset = () => {
    setBlobUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setElapsed(0);
    setError(null);
    chunksRef.current = [];
  };

  const stopRecording = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setRecording(false);
  };

  useEffect(() => {
    if (!open) {
      stopRecording();
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== "inactive"
      ) {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // ignore
        }
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      setBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, []);

  const startRecording = async () => {
    try {
      reset();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!openRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const preferredMime = "audio/webm";
      const recorder =
        typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(preferredMime)
          ? new MediaRecorder(stream, { mimeType: preferredMime })
          : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const mime = recorder.mimeType || preferredMime;
        const blob = new Blob(chunksRef.current, { type: mime });
        setBlobUrl(URL.createObjectURL(blob));
      };
      recorder.start();
      startTimeRef.current = Date.now();
      setRecording(true);
      timerRef.current = setInterval(() => {
        setElapsed(Date.now() - startTimeRef.current);
      }, 200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Microphone unavailable");
    }
  };

  const confirm = () => {
    const mime = mediaRecorderRef.current?.mimeType || "audio/webm";
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    const blob = new Blob(chunksRef.current, { type: mime });
    const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: mime });
    onRecorded(file);
    setOpen(false);
    reset();
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title="Voice"
          className="flex size-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-[#f5f6f8] hover:text-slate-800"
        >
          <Mic className="size-4" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          className="z-50 w-64 rounded-lg border border-border bg-popover p-3 shadow-lg"
        >
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : blobUrl ? (
            <div className="flex flex-col gap-2">
              <audio src={blobUrl} controls className="w-full" />
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={reset}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-slate-500 hover:bg-accent"
                >
                  <Trash2 className="size-3.5" /> Discard
                </button>
                <button
                  type="button"
                  onClick={confirm}
                  className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                >
                  <Check className="size-3.5" /> Attach
                </button>
              </div>
            </div>
          ) : recording ? (
            <div className="flex flex-col items-center gap-2">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
                <span className="size-2 animate-pulse rounded-full bg-red-500" />
                {formatTime(elapsed)}
              </div>
              <button
                type="button"
                onClick={stopRecording}
                className="inline-flex items-center gap-1 rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-900"
              >
                <Square className="size-3.5" /> Stop
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <p className="text-xs text-slate-500">Record a voice message</p>
              <button
                type="button"
                onClick={() => void startRecording()}
                className="inline-flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                <Mic className="size-3.5" /> Start
              </button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
