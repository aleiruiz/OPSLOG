import React from 'react';
import UploadFileOutlined from '@mui/icons-material/UploadFileOutlined';
import Box from '@mui/material/Box';

/**
 * Button that opens the file picker (or the camera when `capture` is set). The native input stays in the
 * tab order, visually hidden, so keyboard and screen-reader users operate the real control; the label is
 * its name. The chosen files are handed over and the input is cleared so the same file can be picked again.
 */
export function FileButton({
  label,
  accept,
  capture,
  multiple = false,
  disabled = false,
  icon,
  onFiles,
}: {
  label: string;
  accept?: string;
  /** Opens the device camera on phones (`environment`: rear camera). */
  capture?: 'environment' | 'user';
  multiple?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  onFiles: (files: File[]) => void;
}) {
  const id = React.useId();
  return (
    <Box
      component="label"
      htmlFor={id}
      sx={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        px: 2,
        py: 0.75,
        minHeight: 40,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        typography: 'button',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        '&:hover': disabled ? {} : { borderColor: 'primary.main', color: 'primary.main' },
        '&:has(input:focus-visible)': {
          outline: 2,
          outlineColor: 'primary.main',
          outlineOffset: 2,
        },
      }}
    >
      {icon ?? <UploadFileOutlined aria-hidden="true" fontSize="small" />}
      {label}
      <Box
        component="input"
        id={id}
        type="file"
        disabled={disabled}
        multiple={multiple}
        {...(accept === undefined ? {} : { accept })}
        {...(capture === undefined ? {} : { capture })}
        sx={{
          position: 'absolute',
          width: 1,
          height: 1,
          m: '-1px',
          p: 0,
          border: 0,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
          const input = event.target;
          const files = Array.from(input.files ?? []);
          input.value = '';
          if (files.length > 0) onFiles(files);
        }}
      />
    </Box>
  );
}
