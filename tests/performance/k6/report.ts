import { arch, cpus, platform, release, totalmem } from 'node:os';
import type { LoadSummary, ScenarioFile } from './config.js';
import type { SeedSize } from './seed.js';

export interface MachineInfo {
  readonly cpuModel: string;
  readonly cpuCount: number;
  readonly memoryGiB: number;
  readonly os: string;
  readonly node: string;
}

export function machineInfo(): MachineInfo {
  const list = cpus();
  return {
    cpuModel: (list[0]?.model ?? 'unknown').replace(/\s+/g, ' ').trim(),
    cpuCount: list.length,
    memoryGiB: Math.round((totalmem() / 2 ** 30) * 10) / 10,
    os: `${platform()} ${release()} ${arch()}`,
    node: process.version,
  };
}

export interface ReportInput {
  readonly summary: LoadSummary;
  /** The same scenarios with one virtual user: the reference for NFR-P5 (degradation under concurrency). */
  readonly baseline?: LoadSummary | undefined;
  readonly file: ScenarioFile;
  readonly machine: MachineInfo;
  readonly size: SeedSize;
  readonly backend: 'mysql' | 'memory';
  readonly mysqlVersion?: string | undefined;
  readonly commit: string;
  readonly date: string;
}

export interface MetricRow {
  readonly id: string;
  readonly label: string;
  readonly requirement: string;
  readonly budgetMs: number;
  readonly p95Ms: number;
  readonly count: number;
  readonly failedRate: number;
  /** p95 with one virtual user, when a baseline ran. */
  readonly baselineP95Ms?: number | undefined;
  readonly failedStatuses?: Readonly<Record<string, number>> | undefined;
  /** `within` when p95 <= budget and no call failed; otherwise `over` or `failed`. */
  readonly verdict: 'within' | 'over' | 'failed' | 'no_data';
}

export function metricRows(
  summary: LoadSummary,
  file: ScenarioFile,
  baseline?: LoadSummary,
): MetricRow[] {
  return file.scenarios.map((scenario) => {
    const stats = summary.scenarios[scenario.id];
    const count = stats?.count ?? 0;
    const failedRate = stats?.failedRate ?? 0;
    const p95Ms = stats?.p95Ms ?? 0;
    const verdict =
      count === 0
        ? 'no_data'
        : failedRate > 0.01
          ? 'failed'
          : p95Ms <= scenario.budgetMs
            ? 'within'
            : 'over';
    const baselineP95Ms = baseline?.scenarios[scenario.id]?.p95Ms;
    return {
      id: scenario.id,
      label: scenario.label,
      requirement: scenario.requirement,
      budgetMs: scenario.budgetMs,
      p95Ms,
      count,
      failedRate,
      baselineP95Ms,
      failedStatuses: stats?.failedStatuses,
      verdict,
    };
  });
}

const VERDICT: Record<MetricRow['verdict'], string> = {
  within: 'dentro del objetivo',
  over: 'por encima del objetivo',
  failed: 'con errores',
  no_data: 'sin datos',
};
function degradationNote(rows: readonly MetricRow[]): string {
  const measured = rows.filter((r) => r.baselineP95Ms !== undefined && r.baselineP95Ms > 0);
  if (measured.length === 0)
    return 'NFR-P5 (sin degradación > 20 % del p95 con 50 usuarios por empresa): no se midió la referencia de un usuario.';
  const worst = measured.reduce((a, b) =>
    b.p95Ms / (b.baselineP95Ms as number) > a.p95Ms / (a.baselineP95Ms as number) ? b : a,
  );
  const ratio = worst.p95Ms / (worst.baselineP95Ms as number) - 1;
  return `NFR-P5: la mayor degradación del p95 frente a un solo usuario es ${(ratio * 100).toFixed(0)} % (${worst.label}); el umbral es 20 %. La razón se calcula sobre p95 de pocas decenas de milisegundos y de una corrida corta: se juzga también contra el objetivo absoluto de cada fila y no se presenta como medición de capacidad.`;
}

/** `12,0 %` plus the statuses behind it when the driver recorded them. */
function failures(row: MetricRow): string {
  const rate = `${(row.failedRate * 100).toFixed(1).replace('.', ',')} %`;
  const detail = row.failedStatuses
    ? Object.entries(row.failedStatuses)
        .map(([status, n]) => `${status}×${n}`)
        .join(' ')
    : '';
  return detail ? `${rate} (${detail})` : rate;
}

const ms = (value: number): string => `${value.toFixed(1).replace('.', ',')} ms`;

/**
 * The Spanish markdown report: p95 per metric against SPECS §9.3 and NFR-P1 to P6, the machine, the
 * dataset and the caveats. It never presents the figures as validation of production.
 */
export function renderReport(input: ReportInput): string {
  const { summary, file, machine, size } = input;
  const rows = metricRows(summary, file, input.baseline);
  const lines = [
    `# Informe de carga (MVP-OPS-M5, PR 2)`,
    '',
    `Fecha ${input.date}, commit \`${input.commit}\`. **No es una validación de producción**: una empresa sintética, una sola máquina de desarrollo, sin red entre cliente y servidor.`,
    '',
    '## Entorno',
    '',
    `- Máquina: ${machine.cpuCount} vCPU ${machine.cpuModel}, ${machine.memoryGiB} GiB, ${machine.os}, Node ${machine.node}. La pila objetivo es una VPS de 2 vCPU y 8 GB compartida: esta corrida no la representa.`,
    `- Servidor: ${input.backend === 'mysql' ? `punto de entrada real de la API (\`startServer\`, con su worker y su registro de peticiones) sobre MySQL ${input.mysqlVersion ?? 'desconocido'} local; la pila Docker Compose no se usó (sin Docker)` : 'plataforma y BFF en memoria dentro del proceso de prueba (solo valida los escenarios, no mide)'}.`,
    `- Generador: ${summary.driver === 'k6' ? `k6 (${summary.k6Image ?? file.k6Image})` : 'controlador Node con `fetch` (k6 no estaba disponible en esta máquina; mismos escenarios y tiempos de espera, otro generador)'}; ${summary.vus} usuarios virtuales, ${summary.durationSeconds} s, ${file.thinkMs} ms de espera media entre peticiones (variable de 0,5 a 1,5 veces; la referencia de un usuario espera 100 ms).`,
    `- Datos (una empresa): ${size.vehicles} vehículos y ${size.employees} empleados creados por la API (datos personales cifrados), ${size.searchEntities.toLocaleString('es-MX')} entidades en la proyección de búsqueda (generador de \`tests/performance/search\`).`,
    '',
    '## p95 por métrica',
    '',
    `| Escenario | Requisito | Objetivo | p95 (${summary.vus} usuarios) | p95 (1 usuario) | Muestras | Fallos | Resultado |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.label} | ${r.requirement} | ${r.budgetMs} ms | ${ms(r.p95Ms)} | ${r.baselineP95Ms === undefined ? 'no medido' : ms(r.baselineP95Ms)} | ${r.count} | ${failures(r)} | ${VERDICT[r.verdict]} |`,
    ),
    '',
    degradationNote(rows),
    '',
    '## Límites',
    '',
    '- Los 20 clientes, 500 sesiones totales y 100.000 registros operativos por empresa de SPECS §9.3 son un paso de la cuenta del cliente; aquí hay una empresa, hasta 50 sesiones y 100.000 entidades solo en la proyección de búsqueda (las tablas operativas tienen los registros sembrados arriba).',
    '- NFR-P3 (archivo de 10 MB en 4G) no se mide: depende de la red y del almacenamiento de objetos de la cuenta del cliente. La búsqueda sobre 1 M de registros sigue siendo el paso manual de `docs/operations/SEARCH_PERFORMANCE.md`.',
    '- La alta de vehículos (escritura) crece los datos durante la corrida; el dashboard y las listas se miden con esos datos ya sembrados más lo escrito.',
    '',
  ];
  return lines.join('\n');
}
