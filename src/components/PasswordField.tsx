import { useId, useState, type ComponentPropsWithoutRef } from "react";
import { Eye, EyeOff } from "lucide-react";

interface PasswordFieldProps extends Omit<ComponentPropsWithoutRef<"input">, "type"> {
  wrapperClassName?: string;
  toggleButtonClassName?: string;
}

function joinClassNames(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export default function PasswordField({
  wrapperClassName,
  className,
  toggleButtonClassName,
  disabled,
  id,
  style,
  ...props
}: PasswordFieldProps) {
  const generatedId = useId();
  const [revealed, setRevealed] = useState(false);
  const inputId = id ?? generatedId;
  const toggleLabel = revealed ? "Hide password" : "Show password";

  return (
    <div className={joinClassNames("relative", wrapperClassName)}>
      <input
        {...props}
        id={inputId}
        type={revealed ? "text" : "password"}
        disabled={disabled}
        style={{ ...style, paddingRight: "2.5rem" }}
        className={className}
      />
      <button
        type="button"
        aria-label={toggleLabel}
        aria-controls={inputId}
        aria-pressed={revealed}
        disabled={disabled}
        onClick={() => setRevealed((current) => !current)}
        className={joinClassNames(
          "absolute inset-y-0 right-0 flex items-center rounded-md px-2 text-text-tertiary transition-colors hover:text-text-primary focus:outline-none focus-visible:text-text-primary focus-visible:ring-1 focus-visible:ring-blue-500/50 disabled:pointer-events-none disabled:opacity-50",
          toggleButtonClassName,
        )}
      >
        {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
