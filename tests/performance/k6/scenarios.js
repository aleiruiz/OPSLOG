// k6 script of the MVP-OPS load test (SPECS §9.3, NFR-P1 to NFR-P4). `pnpm ops:load` starts the local
// stack and runs the pinned grafana/k6 image with this file (see README.md). Environment:
//   OPSLOG_LOAD_BASE_URL   base URL of the local stack
//   OPSLOG_LOAD_FIXTURE    JSON of the stack: origin, sessions (cookie + CSRF token), areaId, vehicleIds, ...
//   OPSLOG_LOAD_DURATION   default 60s       OPSLOG_LOAD_VUS / OPSLOG_LOAD_THINK_MS   default from scenarios.json
//   OPSLOG_LOAD_SUMMARY    where handleSummary writes the JSON summary (default /out/k6-summary.json)
// It creates vehicles: never point it at the shared demo.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { expand, expandBody } from './scenario-lib.js';

const config = JSON.parse(open('./scenarios.json'));
const base = __ENV.OPSLOG_LOAD_BASE_URL;
const fixture = JSON.parse(__ENV.OPSLOG_LOAD_FIXTURE || '{}');
const summaryPath = __ENV.OPSLOG_LOAD_SUMMARY || '/out/k6-summary.json';
const vus = Number(__ENV.OPSLOG_LOAD_VUS || config.vus);
const thinkMs = Number(__ENV.OPSLOG_LOAD_THINK_MS || config.thinkMs);

const durations = {};
const failures = {};
const thresholds = {};
for (const scenario of config.scenarios) {
  durations[scenario.id] = new Trend(`d_${scenario.id}`, true);
  failures[scenario.id] = new Rate(`f_${scenario.id}`);
  // k6 exits non-zero when a budget is exceeded; the JSON summary is written either way.
  thresholds[`d_${scenario.id}`] = [`p(95)<${scenario.budgetMs}`];
  thresholds[`f_${scenario.id}`] = ['rate<0.01'];
}

export const options = {
  scenarios: {
    users: { executor: 'constant-vus', vus, duration: __ENV.OPSLOG_LOAD_DURATION || '60s' },
  },
  thresholds,
};

/** Each virtual user is one of the pre-opened sessions of the stack (cookie and CSRF token). */
const sessionOf = (vu) => fixture.sessions[(vu - 1) % fixture.sessions.length];

function send(method, path, body, session, scenarioId) {
  const write = method !== 'GET';
  const headers = { Accept: 'application/json', Cookie: session.cookie };
  if (write) {
    headers['Content-Type'] = 'application/json';
    headers.Origin = fixture.origin;
    headers['X-CSRF-Token'] = session.csrf;
  }
  return http.request(method, base + path, body, {
    headers,
    // A fresh jar per request: the client adds no cookies besides the one set by hand (the BFF's cookies are `Secure`).
    jar: new http.CookieJar(),
    tags: { scenario_id: scenarioId },
  });
}

// Users are independent: each starts at a random point of its cycle and waits 0.5 to 1.5 times the
// think time, so the 50 of them do not hit the same endpoint in the same instant.
const think = () => (thinkMs / 1000) * (0.5 + Math.random());

export default function () {
  const session = sessionOf(__VU);
  if (__ITER === 0) sleep(Math.random() * think() * config.scenarios.length);
  for (const scenario of config.scenarios) {
    const response = send(
      scenario.method,
      expand(scenario.path, fixture, __VU, __ITER),
      scenario.method === 'GET' ? undefined : expandBody(scenario.body, fixture, __VU, __ITER),
      session,
      scenario.id,
    );
    const ok = check(response, {
      [`${scenario.id} answers ${scenario.expectStatus}`]: (r) =>
        r.status === scenario.expectStatus,
    });
    failures[scenario.id].add(!ok);
    durations[scenario.id].add(response.timings.duration);
    sleep(think());
  }
}

// Summary values sit under `values` in the classic summary object and at the top in newer k6 versions.
const valueOf = (metric, key) =>
  (metric ? (metric.values ? metric.values[key] : metric[key]) : null) ?? null;

export function handleSummary(data) {
  const scenarios = {};
  for (const scenario of config.scenarios) {
    const trend = data.metrics[`d_${scenario.id}`];
    scenarios[scenario.id] = {
      count: valueOf(trend, 'count'),
      avgMs: valueOf(trend, 'avg'),
      p95Ms: valueOf(trend, 'p(95)'),
      maxMs: valueOf(trend, 'max'),
      failedRate: valueOf(data.metrics[`f_${scenario.id}`], 'rate'),
    };
  }
  const durationSeconds = Math.round(((data.state && data.state.testRunDurationMs) || 0) / 1000);
  const summary = { driver: 'k6', k6Image: config.k6Image, vus, durationSeconds, scenarios };
  return { [summaryPath]: JSON.stringify(summary, null, 2) };
}
