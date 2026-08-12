import React, {
  forwardRef,
  useId,
  useRef,
  type ChangeEvent,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import Button from './Button.js';
import ModernSelect, { type ModernSelectOption } from '../ModernSelect.js';

type FieldChromeProps = {
  label?: ReactNode;
  helperText?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  containerClassName?: string;
  containerStyle?: CSSProperties;
};

export type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & FieldChromeProps & {
  type?: 'text' | 'password' | 'email' | 'url' | 'search' | 'tel' | 'number';
};

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({
  className = '',
  type = 'text',
  ...props
}, ref) {
  const checkboxClass = type === 'checkbox' || type === 'radio' ? 'ui-choice-input' : 'ui-input';
  return <input ref={ref} type={type} className={`${checkboxClass} ${className}`.trim()} {...props} />;
});

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea({
  className = '',
  ...props
}, ref) {
  return <textarea ref={ref} className={`ui-textarea ${className}`.trim()} {...props} />;
});

export type OptionProps = {
  value: string | number;
  disabled?: boolean;
  children: ReactNode;
};

export function Option(_props: OptionProps) {
  return null;
}

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (React.isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return '';
}

function collectOptions(children: ReactNode, result: ModernSelectOption[] = []): ModernSelectOption[] {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const element = child as ReactElement<OptionProps>;
    if (element.type === Option) {
      result.push({
        value: String(element.props.value),
        label: nodeText(element.props.children),
        disabled: element.props.disabled,
      });
      return;
    }
    const nestedChildren = (child.props as { children?: ReactNode }).children;
    if (nestedChildren !== undefined) collectOptions(nestedChildren, result);
  });
  return result;
}

export type SelectProps = {
  value: string | number;
  onChange: (event: { target: { value: string } }) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  searchable?: boolean;
  size?: 'md' | 'sm';
  placeholder?: string;
  emptyLabel?: string;
  'aria-label'?: string;
  'data-testid'?: string;
};

export function Select({ children, onChange, style, ...props }: SelectProps) {
  return (
    <span className="ui-select-shell" style={style}>
      <ModernSelect
        {...props}
        value={String(props.value)}
        onChange={(value) => onChange({ target: { value } })}
        options={collectOptions(children)}
      />
    </span>
  );
}

function FieldChrome({
  id,
  label,
  helperText,
  error,
  required,
  containerClassName = '',
  containerStyle,
  children,
}: FieldChromeProps & { id: string; children: ReactNode }) {
  const content = (
    <>
      {label !== undefined ? (
        <span className="ui-field-label">
          {label}
          {required ? <span className="ui-field-required" aria-hidden="true"> *</span> : null}
        </span>
      ) : null}
      {children}
      {error ? <span id={`${id}-message`} className="ui-field-message ui-field-error">{error}</span> : null}
      {!error && helperText ? <span id={`${id}-message`} className="ui-field-message">{helperText}</span> : null}
    </>
  );

  const chromeProps = {
    className: `ui-field ${error ? 'has-error' : ''} ${containerClassName}`.trim(),
    style: containerStyle,
  };
  return label !== undefined
    ? <label {...chromeProps} htmlFor={id}>{content}</label>
    : <div {...chromeProps}>{content}</div>;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField({
  id: providedId,
  label,
  helperText,
  error,
  required,
  containerClassName,
  containerStyle,
  className = '',
  'aria-describedby': ariaDescribedBy,
  ...props
}, ref) {
  const generatedId = useId();
  const id = providedId || generatedId;
  const messageId = error || helperText ? `${id}-message` : undefined;

  return (
    <FieldChrome
      id={id}
      label={label}
      helperText={helperText}
      error={error}
      required={required}
      containerClassName={containerClassName}
      containerStyle={containerStyle}
    >
      <input
        ref={ref}
        id={id}
        className={`ui-input ${className}`.trim()}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={ariaDescribedBy || messageId}
        {...props}
      />
    </FieldChrome>
  );
});

export type NumberFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & FieldChromeProps;

export const NumberField = forwardRef<HTMLInputElement, NumberFieldProps>(function NumberField(props, ref) {
  return <TextField ref={ref} {...props} type="number" inputMode="decimal" />;
});

export type SelectFieldProps = FieldChromeProps & {
  value: string | number;
  onChange: (value: string) => void;
  options: ModernSelectOption[];
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  searchable?: boolean;
  searchPlaceholder?: string;
  size?: 'md' | 'sm';
  'aria-label'?: string;
  'data-testid'?: string;
};

export function SelectField({
  value,
  onChange,
  options,
  label,
  helperText,
  error,
  required,
  containerClassName,
  containerStyle,
  className,
  style,
  ...props
}: SelectFieldProps) {
  const generatedId = useId();
  return (
    <FieldChrome
      id={generatedId}
      label={label}
      helperText={helperText}
      error={error}
      required={required}
      containerClassName={containerClassName}
      containerStyle={{ ...containerStyle, ...style }}
    >
      <ModernSelect
        {...props}
        className={className}
        value={String(value)}
        onChange={onChange}
        options={options}
      />
    </FieldChrome>
  );
}

export type DateTimeFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & FieldChromeProps;

export const DateTimeField = forwardRef<HTMLInputElement, DateTimeFieldProps>(function DateTimeField({
  className = '',
  ...props
}, ref) {
  const generatedId = useId();
  const id = props.id || generatedId;
  const { label, helperText, error, required, containerClassName, containerStyle, ...inputProps } = props;
  return (
    <FieldChrome
      id={id}
      label={label}
      helperText={helperText}
      error={error}
      required={required}
      containerClassName={containerClassName}
      containerStyle={containerStyle}
    >
      <input
        ref={ref}
        {...inputProps}
        id={id}
        type="datetime-local"
        required={required}
        className={`ui-input ${className}`.trim()}
        aria-invalid={error ? true : undefined}
      />
    </FieldChrome>
  );
});

export type TextAreaFieldProps = TextareaHTMLAttributes<HTMLTextAreaElement> & FieldChromeProps;

export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(function TextAreaField({
  id: providedId,
  label,
  helperText,
  error,
  required,
  containerClassName,
  containerStyle,
  className = '',
  'aria-describedby': ariaDescribedBy,
  ...props
}, ref) {
  const generatedId = useId();
  const id = providedId || generatedId;
  const messageId = error || helperText ? `${id}-message` : undefined;
  return (
    <FieldChrome
      id={id}
      label={label}
      helperText={helperText}
      error={error}
      required={required}
      containerClassName={containerClassName}
      containerStyle={containerStyle}
    >
      <textarea
        ref={ref}
        id={id}
        required={required}
        className={`ui-textarea ${className}`.trim()}
        aria-invalid={error ? true : undefined}
        aria-describedby={ariaDescribedBy || messageId}
        {...props}
      />
    </FieldChrome>
  );
});

export type SwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
};

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  className = '',
  'aria-label': ariaLabel,
}: SwitchProps) {
  return (
    <span className={`ui-switch-row ${disabled ? 'is-disabled' : ''} ${className}`.trim()}>
      <span className="ui-switch-copy">
        <span className="ui-switch-label">{label}</span>
        {description ? <span className="ui-switch-description">{description}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel || (typeof label === 'string' ? label : undefined)}
        className={`ui-switch ${checked ? 'is-checked' : ''}`.trim()}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="ui-switch-thumb" />
      </button>
    </span>
  );
}

export type CheckboxProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
};

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  className = '',
  'aria-label': ariaLabel,
}: CheckboxProps) {
  return (
    <span className={`ui-checkbox-row ${disabled ? 'is-disabled' : ''} ${className}`.trim()}>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={ariaLabel || (typeof label === 'string' ? label : undefined)}
        className={`ui-checkbox ${checked ? 'is-checked' : ''}`.trim()}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span aria-hidden="true">✓</span>
      </button>
      <span className="ui-switch-copy">
        <span className="ui-switch-label">{label}</span>
        {description ? <span className="ui-switch-description">{description}</span> : null}
      </span>
    </span>
  );
}

export type FilePickerProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> & {
  onFilesChange: (files: FileList | null) => void;
  buttonLabel?: ReactNode;
  emptyLabel?: ReactNode;
};

export function FilePicker({
  onFilesChange,
  buttonLabel = '选择文件',
  emptyLabel = '未选择文件',
  disabled,
  className = '',
  ...props
}: FilePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileNames, setFileNames] = React.useState<string[]>([]);
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    setFileNames(files ? Array.from(files, (file) => file.name) : []);
    onFilesChange(files);
  };
  return (
    <div className={`ui-file-picker ${className}`.trim()}>
      <input ref={inputRef} className="ui-visually-hidden" type="file" disabled={disabled} onChange={handleChange} {...props} />
      <Button variant="ghost" disabled={disabled} onClick={() => inputRef.current?.click()}>{buttonLabel}</Button>
      <span className="ui-file-picker-name">{fileNames.length ? fileNames.join('、') : emptyLabel}</span>
    </div>
  );
}
