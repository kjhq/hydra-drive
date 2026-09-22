import type { DrivePrompt } from "@types";
import { useEffect, useState } from "react";
export function useDrivePrompt() {
  const [prompt, setPrompt] = useState<DrivePrompt | null>(null);
  useEffect(() => {
    if (!window.electron?.getDrivePrompt) return;
    let mounted = true,
      changed = false;
    const unsubscribe = window.electron.onDrivePromptChanged((value) => {
      changed = true;
      setPrompt(value);
    });
    void window.electron.getDrivePrompt().then((value) => {
      if (mounted && !changed) setPrompt(value);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  const answer = (accepted: boolean) => {
    if (prompt) void window.electron.answerDrivePrompt(prompt.id, accepted);
  };
  return { prompt, answer };
}
