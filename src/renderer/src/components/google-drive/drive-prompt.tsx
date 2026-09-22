import { useDrivePrompt } from "@renderer/hooks/use-drive-prompt";
import { ConfirmationModal } from "../confirmation-modal/confirmation-modal";
export function DrivePromptHost() {
  const { prompt, answer } = useDrivePrompt();
  if (!prompt) return null;
  return (
    <ConfirmationModal
      visible
      title={prompt.title}
      descriptionText={prompt.description}
      confirmButtonLabel={prompt.confirmLabel}
      cancelButtonLabel={prompt.cancelLabel}
      onClose={() => answer(false)}
      onConfirm={() => answer(true)}
    />
  );
}
