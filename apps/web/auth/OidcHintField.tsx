import React from 'react';
import { Field } from '@opslog/ui';
import { useSession } from './session';

/**
 * Account selector of a fake identity provider (local work and UI tests). A real provider needs no
 * input here: the browser is sent to it and comes back with a code, so nothing is rendered.
 */
export function OidcHintField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { ports } = useSession();
  const label = ports.oidc.hintLabel;
  if (!label) return null;
  return (
    <Field
      id={id}
      label={label}
      autoComplete="off"
      required
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** True when the provider needs a hint and none was typed yet. */
export function useHintMissing(hint: string): boolean {
  const { ports } = useSession();
  return Boolean(ports.oidc.hintLabel) && !hint.trim();
}
