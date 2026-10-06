import { mountApp } from './bootstrap';
import { createMockApi } from './mockApi';

// Real BFF wiring is a later task: until then the shell runs against the contract-typed mock.
const container = document.getElementById('root');
if (container) mountApp(container, createMockApi());
