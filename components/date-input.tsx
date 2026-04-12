import React, { useState } from "react";
import { Input } from "@heroui/input";
import { FaTimes } from "react-icons/fa";

/**
 * Date input that avoids the Chrome/Safari ghost-placeholder issue where
 * `<input type="date" value="">` shows today's date as a dim placeholder,
 * making empty fields look pre-filled.
 *
 * Renders as `type="text"` when blank + unfocused (shows nothing) and
 * switches to `type="date"` on focus so the native picker works normally.
 * A small × button appears when a value is set, clearing back to empty.
 *
 * Extracted from pages/photos.tsx's DateFilterInput so all date pickers
 * across the app share the same fix.
 */
export function DateInput({
  label,
  value,
  onChange,
  size = "md",
  className,
  isRequired,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  size?: "sm" | "md" | "lg";
  className?: string;
  isRequired?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const showAsDate = !!value || focused;

  return (
    <Input
      size={size}
      type={showAsDate ? "date" : "text"}
      label={label}
      placeholder=" "
      value={value}
      onValueChange={onChange}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className={className}
      isRequired={isRequired}
      endContent={
        value && !isRequired ? (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()}`}
            className="text-default-400 hover:text-default-600"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
            }}
          >
            <FaTimes size={12} />
          </button>
        ) : null
      }
    />
  );
}
