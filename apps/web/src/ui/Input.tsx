import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from './cn';

const control = 'w-full rounded-md border border-rule-2 bg-sheet px-3 text-ink placeholder:text-ink-3 disabled:opacity-60 disabled:bg-sheet-2 aria-[invalid=true]:border-stop';

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Visually hides the label while keeping it for assistive tech. */
  hideLabel?: boolean;
  className?: string;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/** Label + control + hint + error, wired with aria-describedby. */
export function Field({ label, hint, error, required, hideLabel, className, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className={cn('text-sm font-medium text-ink', hideLabel && 'visually-hidden')}>
        {label}
        {required ? <span className="text-ink-2 font-normal"> (required)</span> : null}
      </label>
      {children({ id, describedBy, invalid: !!error })}
      {hint ? (
        <p id={hintId} className="text-sm text-ink-2">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errId} className="text-sm text-stop" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(control, 'h-10', className)} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(control, 'py-2 min-h-24 leading-relaxed', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn(control, 'h-10 pr-8 appearance-none bg-no-repeat bg-[right_0.6rem_center]', className)} style={{ backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 16 16' fill='none' stroke='%237a8194' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'><path d='M3.5 6 8 10.5 12.5 6'/></svg>\")" }} {...rest}>
      {children}
    </select>
  );
});

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  description?: ReactNode;
}
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ label, description, className, id, ...rest }, ref) {
  const auto = useId();
  const cid = id ?? auto;
  const did = `${cid}-desc`;
  return (
    <div className={cn('flex gap-3 items-start', className)}>
      <input ref={ref} id={cid} type="checkbox" aria-describedby={description ? did : undefined} className="mt-1 size-4 shrink-0 accent-[var(--accent)]" {...rest} />
      <div>
        <label htmlFor={cid} className="text-ink">
          {label}
        </label>
        {description ? (
          <p id={did} className="text-sm text-ink-2">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
});
