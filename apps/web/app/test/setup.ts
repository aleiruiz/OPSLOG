import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// Flows that wait behind the 600 ms draft debounce use explicit waits on settled state; this only adds
// a modest margin for slow CI machines.
configure({ asyncUtilTimeout: 2000 });
