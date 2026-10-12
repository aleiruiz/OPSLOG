import Alert from '@mui/material/Alert';
import { Button } from '@opslog/ui';
import { OptionPicker, useDirectory } from './directory';

/** The company's vehicles by economic number and model; never a free-text id. */
export function VehiclePicker({
  id,
  value,
  onChange,
  label = 'Vehículo',
  placeholder = 'Elige un vehículo',
  required = true,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  required?: boolean;
}) {
  const directory = useDirectory();
  if (directory.vehicles === null)
    return (
      <Alert
        severity="error"
        role="alert"
        action={
          directory.reloadVehicles && (
            <Button color="inherit" onClick={directory.reloadVehicles}>
              Reintentar
            </Button>
          )
        }
      >
        No pudimos cargar los vehículos de tu empresa.
      </Alert>
    );
  if (directory.vehicles.length === 0)
    return <Alert severity="info">Aún no hay vehículos registrados en tu empresa.</Alert>;
  return (
    <OptionPicker
      id={id}
      label={label}
      required={required}
      placeholder={placeholder}
      options={directory.vehicles}
      value={value}
      onChange={onChange}
      {...(directory.vehiclesTruncated
        ? { description: 'Se muestran los primeros vehículos; usa el número económico.' }
        : {})}
    />
  );
}
