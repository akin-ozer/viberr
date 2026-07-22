/**
 * Controlled toggle switch.
 * Fully controlled; `onChange` takes no arguments — the caller flips its
 * own state. `label` is required aria copy (every mock call site passes it).
 */
export function TglP({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={"tgl" + (on ? " on" : "")}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onChange}
    >
      <span className="knob"></span>
    </button>
  );
}
