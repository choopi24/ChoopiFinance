import type { ReactNode } from "react";
import { Button } from "./Button";

interface MergePromptProps {
  message: string;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
  icon?: ReactNode;
}

export function MergePrompt({ message, action, onDismiss, icon }: MergePromptProps) {
  return (
    <div className="cf-merge-prompt">
      {icon && <span className="cf-merge-icon">{icon}</span>}
      <p className="cf-merge-msg">{message}</p>
      <div className="cf-merge-actions">
        {action && (
          <Button variant="primary" size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        )}
        {onDismiss && (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}
