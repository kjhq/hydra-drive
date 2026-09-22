import { useDrivePrompt } from "@renderer/hooks/use-drive-prompt";
import { ConfirmationModal } from "../modals/confirmation";
export function BigPictureDrivePromptHost() {
  const { prompt, answer } = useDrivePrompt();
  if (!prompt) return null;
  return (
    <ConfirmationModal
      visible
      title={prompt.title}
      description={prompt.description}
      confirmLabel={prompt.confirmLabel}
      cancelLabel={prompt.cancelLabel}
      onClose={() => answer(false)}
      onConfirm={() => answer(true)}
    />
  );
}
