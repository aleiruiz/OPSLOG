import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// Flows that wait behind the 600 ms draft debounce use explicit waits on settled state; this only adds
// a margin for slow CI machines, where the whole web suite takes close to 7 minutes and a screen can
// need more than 2 s to settle.
configure({ asyncUtilTimeout: 5000 });
