import type { InputHTMLAttributes } from 'react';

interface NumericInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: string;
  onValueChange: (value: string) => void;
}

/** 数字编辑始终保存原始字符串；`0.` / `1.` 这类合法输入中间态不能被 Number() 提前吃掉。 */
export function NumericInput({ value, onValueChange, ...props }: NumericInputProps) {
  return <input {...props} inputMode="decimal" value={value} onChange={(event) => onValueChange(event.target.value)} />;
}

export function parseNumericInput(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
