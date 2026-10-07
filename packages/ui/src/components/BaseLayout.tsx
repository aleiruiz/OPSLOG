import React from 'react';
import Box from '@mui/material/Box';
import Step from '@mui/material/Step';
import StepButton from '@mui/material/StepButton';
import Stack from '@mui/material/Stack';
import Stepper from '@mui/material/Stepper';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Typography from '@mui/material/Typography';
import { ButtonControl } from './BaseControls';

export function FilterBar({
  children,
  onClear,
}: {
  children: React.ReactNode;
  onClear?: () => void;
}) {
  return (
    <Stack
      component="form"
      direction={{ xs: 'column', sm: 'row' }}
      spacing={2}
      alignItems={{ sm: 'center' }}
      role="search"
      aria-label="Filtros"
    >
      {children}
      {onClear && (
        <ButtonControl variant="text" onClick={onClear}>
          Limpiar filtros
        </ButtonControl>
      )}
    </Stack>
  );
}
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <Stack
      component="header"
      direction={{ xs: 'column', sm: 'row' }}
      justifyContent="space-between"
      gap={2}
      sx={{ mb: 3 }}
    >
      <Box>
        <Typography component="h1" variant="h1">
          {title}
        </Typography>
        {description && <Typography color="text.secondary">{description}</Typography>}
      </Box>
      {actions && (
        <Stack direction="row" gap={1} flexWrap="wrap" sx={{ minWidth: 0 }}>
          {actions}
        </Stack>
      )}
    </Stack>
  );
}
export function DetailTabs({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: string; label: string; content?: React.ReactNode }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Box>
      <Tabs
        value={value}
        onChange={(_, next) => onChange(next)}
        aria-label="Secciones del detalle"
        variant="scrollable"
        scrollButtons="auto"
      >
        {tabs.map((tab) => (
          <Tab
            key={tab.id}
            value={tab.id}
            label={tab.label}
            id={`tab-${tab.id}`}
            aria-controls={`tabpanel-${tab.id}`}
          />
        ))}
      </Tabs>
      {tabs.map((tab) => (
        <Box
          key={tab.id}
          role="tabpanel"
          hidden={value !== tab.id}
          id={`tabpanel-${tab.id}`}
          aria-labelledby={`tab-${tab.id}`}
          tabIndex={0}
          sx={{ pt: 2 }}
        >
          {value === tab.id && tab.content}
        </Box>
      ))}
    </Box>
  );
}
export function Wizard({
  steps,
  activeStep,
  onStepChange,
}: {
  steps: string[];
  activeStep: number;
  onStepChange?: (step: number) => void;
}) {
  return (
    <Stepper
      activeStep={activeStep}
      alternativeLabel
      aria-label="Progreso del formulario"
      sx={{ '& .MuiStepButton-root': { px: 0, minWidth: 0 }, '& .MuiStep-root': { px: 0.5 } }}
    >
      {steps.map((label, index) => (
        <Step key={label} completed={index < activeStep}>
          <StepButton onClick={() => onStepChange?.(index)}>{label}</StepButton>
        </Step>
      ))}
    </Stepper>
  );
}
