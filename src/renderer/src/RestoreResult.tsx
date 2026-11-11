import { useMemo } from 'react'
import type { RestoreReport, RowStatus } from '../../shared/types'

const STATUS_LABEL: Record<RowStatus, string> = {
  restored: 'Restored',
  mismatch: 'Did not restore',
  unavailable: 'Not available',
  skipped: 'Not touched'
}
const STATUS_ORDER: RowStatus[] = ['mismatch', 'unavailable', 'restored', 'skipped']
const format = (value: number | null) => (value === null ? '—' : Number(value.toFixed(4)).toString())

export function restoreSummary(report: RestoreReport): string {
  const restored = report.rows.filter((row) => row.status === 'restored').length
  const failed = report.rows.filter((row) => row.status === 'mismatch')
  if (failed.length === 0) return `All set. ${restored} settings restored.`
  return `${restored} settings restored. These didn't come back: ${failed.map((row) => row.label).join(', ')}.`
}

/** A one-line result, with every item behind "Details". */
export function RestoreResult({ report, onDismiss }: { report: RestoreReport; onDismiss: () => void }) {
  const rows = useMemo(
    () =>
      report.rows
        .filter((row) => !(row.target === null && row.actual === null))
        .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)),
    [report]
  )
  return (
    <div className="restore-result" role="status">
      <p>
        {restoreSummary(report)} <span className="muted">{(report.durationMs / 1000).toFixed(1)}s</span>{' '}
        <button className="link" onClick={onDismiss}>
          Dismiss
        </button>
      </p>
      {report.warnings.length > 0 && (
        <ul className="warnings">
          {report.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <details>
        <summary>Details</summary>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Saved</th>
              <th>Now</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={row.status}>
                <td>{row.label}</td>
                <td>{format(row.target)}</td>
                <td>{format(row.actual)}</td>
                <td>{STATUS_LABEL[row.status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}
