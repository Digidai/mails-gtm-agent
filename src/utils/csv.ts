import { ContactImportRow } from '../types'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface CsvParseResult {
  contacts: ContactImportRow[]
  errors: string[]
  duplicates: number
}

export function parseCsv(csvText: string): CsvParseResult {
  const errors: string[] = []
  const contacts: ContactImportRow[] = []
  const seenEmails = new Set<string>()
  let duplicates = 0

  const trimmed = csvText.trim()
  if (!trimmed) {
    errors.push('Empty CSV file')
    return { contacts, errors, duplicates }
  }

  const lines = trimmed.split(/\r?\n/)
  if (lines.length === 0) {
    errors.push('Empty CSV file')
    return { contacts, errors, duplicates }
  }

  // Parse header
  const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase())
  const emailIdx = headers.indexOf('email')

  if (emailIdx === -1) {
    errors.push('CSV must contain an "email" column')
    return { contacts, errors, duplicates }
  }

  // Parse rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const values = parseCsvLine(line)
    const row: Record<string, string> = {}

    for (let j = 0; j < headers.length; j++) {
      const header = headers[j]
      const value = values[j]?.trim() || ''
      if (value) {
        row[header] = value
      }
    }

    const email = row.email?.toLowerCase()

    if (!email || !EMAIL_REGEX.test(email)) {
      errors.push(`Row ${i + 1}: invalid email "${row.email || ''}"`)
      continue
    }

    if (seenEmails.has(email)) {
      duplicates++
      continue
    }
    seenEmails.add(email)

    // Build custom fields from non-standard columns
    const customFields: Record<string, string> = {}
    for (const [key, value] of Object.entries(row)) {
      if (!['email', 'name', 'company', 'role'].includes(key) && value) {
        customFields[key] = value
      }
    }

    contacts.push({
      email,
      name: row.name,
      company: row.company,
      role: row.role,
      ...customFields,
    })
  }

  return { contacts, errors, duplicates }
}

/**
 * Parse a single CSV line, handling quoted fields
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"'
          i++ // skip escaped quote
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        fields.push(current)
        current = ''
      } else {
        current += ch
      }
    }
  }

  fields.push(current)
  return fields
}
