import React from 'react';
import { RouterProvider } from '../app/router';

/** Providers the vehicle views need to render inside Storybook (links resolve against the router). */
export function Frame({ children }: { children: React.ReactNode }) {
  return <RouterProvider>{children}</RouterProvider>;
}

export const noop = () => undefined;
/** Fixed clock so year limits and default dates never change between runs. */
export const storyNow = new Date('2026-10-06T12:00:00.000Z');
