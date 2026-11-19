// Factory Studio + Agent Workspace — UI primitives on the friendly design kit (friendly.css).
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

export function Page({ children, className, testId, width = 1120 }: { children: ReactNode; className?: string; testId?: string; width?: number }) {
  return (
    <div className="fx" data-testid={testId}>
      <div className={cn("mx-auto w-full px-6 py-8", className)} style={{ maxWidth: width }}>{children}</div>
    </div>
  );
}

export function PageHeader({ eyebrow, title, subtitle, actions, back }: {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <header className="mb-6">
      {back ? <div className="mb-3">{back}</div> : null}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow ? <div className="fx-eyebrow mb-1">{eyebrow}</div> : null}
          <h1 className="fx-h1">{title}</h1>
          {subtitle ? <div className="fx-sub mt-1.5 max-w-[680px]">{subtitle}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="fx-label">{label}</span>
      {children}
      {hint ? <span className="fx-hint">{hint}</span> : null}
    </label>
  );
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn("fx-input", className)} />;
}

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn("fx-input", className)} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cn("fx-input", className)}>
      {children}
    </select>
  );
}

export function Panel({ title, actions, children, className, testId, bodyClassName }: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
  bodyClassName?: string;
}) {
  return (
    <section data-testid={testId} className={cn("fx-card", className)}>
      {title || actions ? (
        <header className="fx-card-head">
          <h2 className="fx-h2 min-w-0">{title}</h2>
          <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
        </header>
      ) : null}
      <div className={cn("fx-card-body", bodyClassName)}>{children}</div>
    </section>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";

export function Button({ className, variant = "secondary", size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" | "icon" }) {
  return (
    <button
      type="button"
      {...props}
      className={cn("fx-btn", `fx-btn-${variant}`, size === "sm" && "fx-btn-sm", size === "icon" && "fx-btn-sm fx-btn-icon", className)}
    />
  );
}

/** Backwards-compatible alias used across the Studio pages. */
export function SmallButton({ variant = "outline", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "outline" | "solid" | "ghost" | "danger" }) {
  const map = { outline: "secondary", solid: "primary", ghost: "ghost", danger: "danger" } as const;
  return <Button size="sm" variant={map[variant]} {...props} />;
}

export type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

export function Pill({ tone = "neutral", dot, pulse, children, className, testId }: {
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <span data-testid={testId} className={cn("fx-pill", tone !== "neutral" && `fx-tone-${tone}`, dot && "fx-pill-dot", pulse && "fx-pill-pulse", className)}>
      {children}
    </span>
  );
}

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return <Pill className={className}>{children}</Pill>;
}

function hashIndex(key: string, buckets: number): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % buckets;
}

export function initials(name: string): string {
  const words = name.replace(/\(.*?\)/g, "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

export function Avatar({ name, colorKey, size }: { name: string; colorKey?: string; size?: "sm" | "md" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={cn("fx-avatar", `fx-av-${hashIndex(colorKey ?? name, 6)}`, size === "sm" && "fx-avatar-sm", size === "lg" && "fx-avatar-lg")}
    >
      {initials(name)}
    </span>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="fx-empty">
      <span className="fx-empty-icon">{icon}</span>
      <div className="fx-h3">{title}</div>
      {children ? <div className="fx-small max-w-[440px]">{children}</div> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function Alert({ tone, icon, title, children, testId }: { tone: Exclude<Tone, "neutral">; icon?: ReactNode; title?: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className={cn("fx-alert", `fx-tone-${tone}`)}>
      {icon}
      <div className="min-w-0">
        {title ? <div className="font-semibold">{title}</div> : null}
        {children ? <div className={cn(title && "mt-0.5", "text-[13px] opacity-95")}>{children}</div> : null}
      </div>
    </div>
  );
}
