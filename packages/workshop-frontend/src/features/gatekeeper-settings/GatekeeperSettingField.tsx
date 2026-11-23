import { useState } from 'react'
import { Button, Input } from '@cloudflare/kumo'
import { MAX_GATEKEEPER_SETTING_LENGTH } from '@gadgets/workshop-shared/api'
import type { GatekeeperAdminSetting } from '@gadgets/workshop-shared/gatekeeper'
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
  const value = draft?.trim()
  const changed = value !== undefined && value !== setting.value

  const edit = (next: string | null) => {
    setDraft(next)
    setRefusal(undefined)
  }

  const save = async () => {
    if (value === undefined) return
    setSaving(true)
    try {
      await onSave(value)
      edit(null)
    } catch (err) {
      setRefusal(rpcFailureDescription(err) ?? `Failed to save. Try again.`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="flex items-start gap-2 px-3 pt-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (changed) void save()
      }}
    >
      <div className="min-w-0 flex-1">
        <Input
          label={setting.label}
          description={setting.help}
          error={refusal}
          variant={refusal ? 'error' : 'default'}
          size="sm"
          className="w-full"
          placeholder={setting.defaultValue}
          maxLength={MAX_GATEKEEPER_SETTING_LENGTH}
          autoComplete="off"
          spellCheck={false}
          value={draft ?? setting.value}
          onChange={(event) => edit(event.target.value)}
          disabled={saving}
        />
      </div>
      {/* The label's height, so the buttons sit beside the input. */}
      <div className="flex items-center gap-2 pt-6">
        {changed && (
          <Button type="button" variant="ghost" size="sm" onClick={() => edit(null)} disabled={saving}>
            Reset
          </Button>
        )}
        <Button type="submit" variant="primary" size="sm" loading={saving} disabled={!changed}>
          Save
        </Button>
      </div>
    </form>
  )
}
