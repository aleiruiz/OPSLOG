import type { ApiError, Vehicle, VehicleInput, VehiclePatch } from '../app/types';
import {
  ECONOMIC_NUMBER,
  LABEL,
  MAX_ODOMETER_KM,
  MIN_MODEL_YEAR,
  PLATE,
  VIN,
  isInteger,
  isPastOrToday,
  maxModelYear,
  normalizePlate,
  normalizeVin,
  todayOf,
} from './rules';

/** What the person types, as text. Numbers are parsed only on submit. */
export interface VehicleFormValues {
  economicNumber: string;
  plate: string;
  vin: string;
  make: string;
  model: string;
  year: string;
  areaId: string;
  odometerKm: string;
  registeredOn: string;
}

export type FieldKey = keyof VehicleFormValues;
export type FieldErrors = Partial<Record<FieldKey, string>>;

/** Order in which fields appear, used to move focus to the first one with an error. */
export const fieldOrder: readonly FieldKey[] = [
  'economicNumber',
  'plate',
  'vin',
  'make',
  'model',
  'year',
  'areaId',
  'odometerKm',
  'registeredOn',
];

export const emptyValues = (today: string): VehicleFormValues => ({
  economicNumber: '',
  plate: '',
  vin: '',
  make: '',
  model: '',
  year: '',
  areaId: '',
  odometerKm: '',
  registeredOn: today,
});

export const valuesOf = (vehicle: Vehicle): VehicleFormValues => ({
  economicNumber: vehicle.economicNumber,
  plate: vehicle.plate,
  vin: vehicle.vin ?? '',
  make: vehicle.make,
  model: vehicle.model,
  year: String(vehicle.year),
  areaId: vehicle.areaId,
  odometerKm: String(vehicle.odometerKm),
  registeredOn: vehicle.registeredOn,
});

const DIGITS = /^\d{1,9}$/;
const kmText = (km: number) => new Intl.NumberFormat('es-MX').format(km);

interface Context {
  readonly mode: 'create' | 'edit';
  readonly now: Date;
  /** Edit only: the odometer reading the form was loaded with. It can only grow. */
  readonly currentOdometerKm?: number | undefined;
}

/** The same rules the backend enforces, with a message per field (the server only says "invalid request"). */
export function validate(values: VehicleFormValues, context: Context): FieldErrors {
  const errors: FieldErrors = {};
  const economicNumber = values.economicNumber.trim();
  if (!economicNumber) errors.economicNumber = 'Escribe el número económico.';
  else if (!ECONOMIC_NUMBER.test(economicNumber))
    errors.economicNumber =
      'Usa hasta 32 caracteres: letras, números, espacio, punto, guion, guion bajo o diagonal.';

  const plate = normalizePlate(values.plate);
  if (!plate) errors.plate = 'Escribe la placa.';
  else if (!PLATE.test(plate))
    errors.plate = 'Usa hasta 16 caracteres: letras, números, espacios o guiones.';

  const vin = normalizeVin(values.vin);
  if (vin && !VIN.test(vin))
    errors.vin = 'El VIN tiene 17 caracteres entre letras y números, sin las letras I, O ni Q.';

  for (const [field, label] of [
    ['make', 'la marca'],
    ['model', 'el modelo'],
  ] as const) {
    const text = values[field].trim();
    if (!text) errors[field] = `Escribe ${label}.`;
    else if (!LABEL.test(text)) errors[field] = 'Usa hasta 60 caracteres, sin saltos de línea.';
  }

  const maxYear = maxModelYear(context.now);
  const yearText = values.year.trim();
  if (!yearText) errors.year = 'Escribe el año del modelo.';
  else if (!/^\d{4}$/.test(yearText) || !isInteger(Number(yearText), MIN_MODEL_YEAR, maxYear))
    errors.year = `Escribe un año entre ${MIN_MODEL_YEAR} y ${maxYear}.`;

  // The area comes from a selector of the company's active areas, so only "none chosen" can be wrong here.
  if (!values.areaId.trim()) errors.areaId = 'Elige el área del vehículo.';

  const odometerText = values.odometerKm.trim();
  if (!odometerText)
    errors.odometerKm =
      context.mode === 'create'
        ? 'Escribe el odómetro actual.'
        : 'Escribe la lectura del odómetro.';
  else if (!DIGITS.test(odometerText) || Number(odometerText) > MAX_ODOMETER_KM)
    errors.odometerKm = `Escribe un número entero de kilómetros entre 0 y ${kmText(MAX_ODOMETER_KM)}.`;
  else if (
    context.currentOdometerKm !== undefined &&
    Number(odometerText) < context.currentOdometerKm
  )
    errors.odometerKm = `El odómetro no puede bajar: la lectura actual es ${kmText(context.currentOdometerKm)} km.`;

  if (context.mode === 'create' && !isPastOrToday(values.registeredOn, todayOf(context.now)))
    errors.registeredOn = 'Elige una fecha de alta que no sea futura.';

  return errors;
}

/** Body of a creation. Call only with values that passed `validate`. */
export function toInput(values: VehicleFormValues): VehicleInput {
  const vin = normalizeVin(values.vin);
  return {
    economicNumber: values.economicNumber.trim(),
    plate: normalizePlate(values.plate),
    ...(vin ? { vin } : {}),
    make: values.make.trim(),
    model: values.model.trim(),
    year: Number(values.year.trim()),
    areaId: values.areaId.trim(),
    odometerKm: Number(values.odometerKm.trim()),
    registeredOn: values.registeredOn,
  };
}

/** What changed against the loaded vehicle: an in-place patch (without version) and a new odometer reading. */
export function changes(
  vehicle: Vehicle,
  values: VehicleFormValues,
): { patch: Omit<VehiclePatch, 'version'> | null; odometerKm: number | null } {
  const next = toInput({ ...values, registeredOn: vehicle.registeredOn });
  const patch: { -readonly [K in keyof Omit<VehiclePatch, 'version'>]?: VehiclePatch[K] } = {};
  if (next.economicNumber !== vehicle.economicNumber) patch.economicNumber = next.economicNumber;
  if (next.plate !== vehicle.plate) patch.plate = next.plate;
  if ((next.vin ?? null) !== vehicle.vin) patch.vin = next.vin ?? null;
  if (next.make !== vehicle.make) patch.make = next.make;
  if (next.model !== vehicle.model) patch.model = next.model;
  if (next.year !== vehicle.year) patch.year = next.year;
  if (next.areaId !== vehicle.areaId) patch.areaId = next.areaId;
  return {
    patch: Object.keys(patch).length > 0 ? patch : null,
    odometerKm: next.odometerKm === vehicle.odometerKm ? null : next.odometerKm,
  };
}

const duplicateMessages: Record<string, [FieldKey, string]> = {
  economic_number: ['economicNumber', 'Ya existe un vehículo con este número económico.'],
  plate: ['plate', 'Ya existe un vehículo con esta placa.'],
  vin: ['vin', 'Ya existe un vehículo con este VIN.'],
};

/** Field messages carried by a 409 `duplicate`: only the field name comes back, never the colliding value. */
export function duplicateErrors(error: ApiError): FieldErrors {
  const errors: FieldErrors = {};
  for (const item of error.fieldErrors ?? []) {
    const known = duplicateMessages[item.field];
    if (known) errors[known[0]] = known[1];
  }
  return errors;
}
