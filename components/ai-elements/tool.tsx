'use client';

import { cn } from '@/lib/utils';
import type { ToolUIPart } from 'ai';
import type { ComponentProps, ReactNode } from 'react';
import { isValidElement } from 'react';

export type ToolInputProps = ComponentProps<'div'> & {
  input: ToolUIPart['input'];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  if (input == null) return null;
  return (
    <div
      className={cn(
        'overflow-x-auto rounded-md border border-stone-200/80 bg-stone-50 px-3 py-2',
        className,
      )}
      {...props}
    >
      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-stone-500">
        {JSON.stringify(input, null, 2)}
      </pre>
    </div>
  );
};

export type ToolOutputProps = ComponentProps<'div'> & {
  output: ToolUIPart['output'];
  errorText: ToolUIPart['errorText'];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) return null;
  const isError = Boolean(errorText);
  const text = errorText
    ? errorText
    : typeof output === 'string'
      ? output
      : isValidElement(output)
        ? null
        : JSON.stringify(output, null, 2);
  return (
    <div
      className={cn(
        'overflow-x-auto rounded-md border px-3 py-2',
        isError ? 'border-red-200/80 bg-red-50' : 'border-stone-200/80 bg-stone-50',
        className,
      )}
      {...props}
    >
      {text != null ? (
        <pre
          className={cn(
            'whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed',
            isError ? 'text-red-500' : 'text-stone-500',
          )}
        >
          {text}
        </pre>
      ) : (
        <div>{output as ReactNode}</div>
      )}
    </div>
  );
};
