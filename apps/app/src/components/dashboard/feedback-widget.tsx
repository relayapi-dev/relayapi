import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

const GITHUB_REPO = "relayapi-dev/relayapi";

const labels = ["bug", "enhancement", "question"];

function formatTime(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

export function FeedbackWidget() {
	const [open, setOpen] = useState(false);
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [type, setType] = useState<"bug" | "enhancement" | "question">("bug");
	const panelRef = useRef<HTMLDivElement>(null);

	// Screen recording state
	const [isRecording, setIsRecording] = useState(false);
	const [recordingTime, setRecordingTime] = useState(0);
	const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
	const [recordingError, setRecordingError] = useState<string | null>(null);
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const streamRef = useRef<MediaStream | null>(null);

	useEffect(() => {
		function handleClickOutside(e: MouseEvent) {
			if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		}
		if (open) {
			document.addEventListener("mousedown", handleClickOutside);
		}
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [open]);

	useEffect(() => {
		return () => {
			if (
				mediaRecorderRef.current &&
				mediaRecorderRef.current.state !== "inactive"
			) {
				mediaRecorderRef.current.stop();
			}
			if (streamRef.current) {
				for (const track of streamRef.current.getTracks()) {
					track.stop();
				}
			}
			if (timerRef.current) {
				clearInterval(timerRef.current);
			}
		};
	}, []);

	const stopRecording = () => {
		if (
			mediaRecorderRef.current &&
			mediaRecorderRef.current.state !== "inactive"
		) {
			mediaRecorderRef.current.stop();
		}
		if (streamRef.current) {
			for (const track of streamRef.current.getTracks()) {
				track.stop();
			}
			streamRef.current = null;
		}
		if (timerRef.current) {
			clearInterval(timerRef.current);
			timerRef.current = null;
		}
		setIsRecording(false);
	};

	const startRecording = async () => {
		setRecordingError(null);
		setRecordedBlob(null);
		chunksRef.current = [];
		setRecordingTime(0);

		try {
			const stream = await navigator.mediaDevices.getDisplayMedia({
				video: { frameRate: { ideal: 30 } },
				audio: false,
			});
			streamRef.current = stream;

			// Detect MIME type: Safari supports mp4, Chrome/Firefox support webm
			const mimeType = MediaRecorder.isTypeSupported(
				"video/webm;codecs=vp8,opus",
			)
				? "video/webm;codecs=vp8,opus"
				: MediaRecorder.isTypeSupported("video/webm")
					? "video/webm"
					: "video/mp4";

			const recorder = new MediaRecorder(stream, {
				mimeType,
				videoBitsPerSecond: 1_000_000, // 1 Mbps — ~3 min fits in 25 MB
			});
			mediaRecorderRef.current = recorder;

			recorder.ondataavailable = (e) => {
				if (e.data.size > 0) {
					chunksRef.current.push(e.data);
				}
			};

			recorder.onstop = () => {
				const blob = new Blob(chunksRef.current, { type: mimeType });
				setRecordedBlob(blob);
			};

			// Handle user clicking browser's native "Stop sharing" button
			const videoTrack = stream.getVideoTracks()[0];
			if (videoTrack) {
				videoTrack.onended = () => {
					stopRecording();
				};
			}

			recorder.start(1000); // Emit data every second
			setIsRecording(true);

			// Start elapsed-time timer
			timerRef.current = setInterval(() => {
				setRecordingTime((t) => t + 1);
			}, 1000);
		} catch (err) {
			// User cancelled the screen picker or browser denied permission
			if (err instanceof Error && err.name !== "NotAllowedError") {
				setRecordingError("Screen recording is not supported in this browser.");
			}
		}
	};

	const downloadRecording = () => {
		if (!recordedBlob) return;
		const ext = recordedBlob.type.includes("mp4") ? "mp4" : "webm";
		const timestamp = new Date()
			.toISOString()
			.replace(/[:.]/g, "-")
			.slice(0, 19);
		const filename = `screen-recording-${timestamp}.${ext}`;
		const url = URL.createObjectURL(recordedBlob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	};

	const discardRecording = () => {
		setRecordedBlob(null);
		setRecordingTime(0);
		setRecordingError(null);
	};

	const handleSubmit = () => {
		if (!title.trim()) return;

		let fullBody = body.trim();
		if (recordedBlob) {
			fullBody +=
				"\n\n---\n> A screen recording was downloaded with this report. Please drag and drop the `.webm`/`.mp4` file below to attach it.";
		}

		const params = new URLSearchParams({
			title: title.trim(),
			body: fullBody,
			labels: type,
		});

		// Auto-download the recording right before opening GitHub
		if (recordedBlob) {
			downloadRecording();
		}

		window.open(
			`https://github.com/${GITHUB_REPO}/issues/new?${params.toString()}`,
			"_blank",
		);

		setTitle("");
		setBody("");
		setType("bug");
		setRecordedBlob(null);
		setRecordingTime(0);
		setRecordingError(null);
		setOpen(false);
	};

	return (
		<div className="fixed bottom-3 right-5 z-50" ref={panelRef}>
			<AnimatePresence>
				{open && (
					<motion.div
						initial={{ opacity: 0, y: 10, scale: 0.95 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						exit={{ opacity: 0, y: 10, scale: 0.95 }}
						transition={{ duration: 0.15 }}
						className="absolute bottom-14 right-0 w-[calc(100vw-2rem)] sm:w-[360px] max-w-[360px] rounded-xl border border-border bg-background shadow-xl"
					>
						{/* Header */}
						<div className="flex items-center gap-2 border-b border-border px-4 py-3">
							<svg className="size-5" viewBox="0 0 24 24" fill="currentColor">
								<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
							</svg>
							<span className="text-sm font-semibold">Submit an Issue</span>
							<button
								onClick={() => setOpen(false)}
								className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
							>
								<svg
									className="size-4"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<line x1="18" y1="6" x2="6" y2="18" />
									<line x1="6" y1="6" x2="18" y2="18" />
								</svg>
							</button>
						</div>

						{/* Body */}
						<div className="space-y-3 p-4">
							{/* Type selector */}
							<div className="flex gap-1.5">
								{labels.map((label) => (
									<button
										key={label}
										onClick={() => setType(label as typeof type)}
										className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
											type === label
												? "bg-primary text-primary-foreground"
												: "bg-muted text-muted-foreground hover:text-foreground"
										}`}
									>
										{label === "bug"
											? "Bug Report"
											: label === "enhancement"
												? "Feature Request"
												: "Question"}
									</button>
								))}
							</div>

							{/* Title */}
							<input
								type="text"
								placeholder="Title"
								value={title}
								onChange={(e) => setTitle(e.target.value)}
								className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
								onKeyDown={(e) => {
									if (e.key === "Enter" && title.trim()) handleSubmit();
								}}
							/>

							{/* Description */}
							<textarea
								placeholder="Describe the issue..."
								value={body}
								onChange={(e) => setBody(e.target.value)}
								rows={4}
								className="w-full resize-none rounded-lg border border-border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
							/>

							{/* Screen recording */}
							<div className="space-y-2">
								{!isRecording && !recordedBlob && (
									<button
										type="button"
										onClick={startRecording}
										className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground hover:border-foreground/20"
									>
										<svg
											className="size-3.5"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<circle cx="12" cy="12" r="10" />
											<circle cx="12" cy="12" r="3" fill="currentColor" />
										</svg>
										Record screen
									</button>
								)}

								{isRecording && (
									<div className="flex items-center gap-2">
										<button
											type="button"
											onClick={stopRecording}
											className="flex items-center gap-1.5 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-1.5 text-xs text-red-600 transition-colors hover:bg-red-500/20"
										>
											<span className="relative flex size-2">
												<span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-75" />
												<span className="relative inline-flex size-2 rounded-full bg-red-500" />
											</span>
											Stop recording
										</button>
										<span className="text-xs tabular-nums text-muted-foreground">
											{formatTime(recordingTime)}
										</span>
									</div>
								)}

								{recordedBlob && (
									<div className="flex items-center gap-2">
										<div className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 text-xs text-emerald-600">
											<svg
												className="size-3.5"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<path d="M20 6 9 17l-5-5" />
											</svg>
											Recording ready ({formatTime(recordingTime)})
										</div>
										<button
											type="button"
											onClick={discardRecording}
											className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors"
										>
											Discard
										</button>
									</div>
								)}

								{recordingError && (
									<p className="text-xs text-red-500">{recordingError}</p>
								)}
							</div>

							{/* Submit */}
							<button
								onClick={handleSubmit}
								disabled={!title.trim()}
								className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
							>
								Open on GitHub
								<svg
									className="size-3.5"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
									<polyline points="15 3 21 3 21 9" />
									<line x1="10" y1="14" x2="21" y2="3" />
								</svg>
							</button>

							<div className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
								<span>Requires a GitHub account.</span>
								<a
									href={`https://github.com/${GITHUB_REPO}`}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground transition-colors"
								>
									View repo
									<svg
										className="size-2.5"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2.5"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
										<polyline points="15 3 21 3 21 9" />
										<line x1="10" y1="14" x2="21" y2="3" />
									</svg>
								</a>
							</div>
						</div>
					</motion.div>
				)}
			</AnimatePresence>

			{/* Floating button */}
			<button
				onClick={() => setOpen(!open)}
				className="flex size-9 items-center justify-center rounded-full bg-black text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
				title="Report an issue"
			>
				<svg className="size-4" viewBox="0 0 24 24" fill="currentColor">
					<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
				</svg>
			</button>
		</div>
	);
}
