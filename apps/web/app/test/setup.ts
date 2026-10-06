import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// Some flows wait behind the 600 ms draft debounce; the default 1000 ms leaves too little margin on CI.
configure({ asyncUtilTimeout: 4000 });
