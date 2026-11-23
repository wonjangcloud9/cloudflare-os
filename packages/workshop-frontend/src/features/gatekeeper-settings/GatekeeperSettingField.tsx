import { useRef, useState } from 'react'
import { Button, Input } from '@cloudflare/kumo'
import { MAX_GATEKEEPER_SETTING_LENGTH } from '@gadgets/workshop-shared/api'
import type { GatekeeperAdminSetting } from '@gadgets/workshop-shared/gatekeeper'
import { useFieldErrorAlert } from '../../hooks/useFieldErrorAlert'
import { rpcFailureDescription } from '../../rpcErrors'

/** One of a gatekeeper's own settings, for a deployment admin to edit. */
export const GatekeeperSettingField = ({ setting, onSave }: {
  /** The setting, with the value in effect. */
  setting: GatekeeperAdminSetting & { value: string }
  /** Stores `value`. Rejects, with the gatekeeper's reason, if the gatekeeper refuses it. */
  onSave: (value: string) => Promise<void>
}) => {
  // The value being edited, or null while the field shows the value in effect.
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [refusal, setRefusal] = useState<string>()
  const field = useRef<HTMLInputElement>(null)
  const fieldError = useFieldErrorAlert()
  const value = draft?.trim()
  const changed = value !== undefined && value !== setting.value

  const edit = (next: string | null) => {
    setDraft(next)
    setRefusal(undefined)
    fieldError.clear()
  }

  const save = async () => {
    if (value === undefined) return
    setSaving(true)
    try {
      await onSave(value)
      edit(null)
    } catch (err) {
      const reason = rpcFailureDescription(err) ?? 'Failed to save. Try again.'
      setRefusal(reason)
      // The field takes focus first, so that the reason is said as an alert: the field's
      // description still holds the help text when focus lands on it.
      field.current?.focus()
      fieldError.pointAt(field.current, reason)
    } finally {
      setSaving(false)
      // A save disables the Save button, and a browser takes focus from a control that becomes
      // disabled without giving it back. The field stays focusable through a save, so it takes
      // the focus the button lost.
      if (document.activeElement === document.body) field.current?.focus()
    }
  }

  return (
    <form
      noValidate
      className="flex items-start gap-2 px-3 pt-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (changed && !saving) void save()
      }}
    >
      <div className="min-w-0 flex-1">
        <Input
          ref={field}
          label={setting.label}
          description={setting.help}
          error={refusal}
          variant={refusal ? 'error' : 'default'}
          aria-invalid={refusal !== undefined}
          size="sm"
          className="w-full"
          placeholder={setting.defaultValue}
          maxLength={MAX_GATEKEEPER_SETTING_LENGTH}
          autoComplete="off"
          spellCheck={false}
          value={draft ?? setting.value}
          onChange={(event) => edit(event.target.value)}
          readOnly={saving}
        />
        {fieldError.alert}
      </div>
      {/* The label's height, so the buttons sit beside the input. */}
      <div className="flex items-center gap-2 pt-6">
        {changed && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => edit(null)}
            disabled={saving}
            aria-label={`Reset “${setting.label}”`}
          >
            Reset
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={saving}
          disabled={!changed}
          aria-label={`Save “${setting.label}”`}
        >
          Save
        </Button>
      </div>
    </form>
  )
}
