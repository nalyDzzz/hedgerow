import { describe, expect, it } from 'vitest'
import { copyText, plainNumber } from './format'

describe('comparing numbers by their digits', () => {
  it('reads the same number the same way however it was written', () => {
    for (const written of ['7', '007', '+7', '7.0', '7.', ' 7 ', 7]) expect(plainNumber(written)).toBe('7')
    expect(plainNumber('12.50')).toBe('12.5')
    expect(plainNumber('.5')).toBe('0.5')
    expect(plainNumber('-0012.340')).toBe('-12.34')
    for (const zero of ['0', '-0', '0.00', '+.0', 0]) expect(plainNumber(zero)).toBe('0')
  })

  it('keeps every digit of a number too long for a double', () => {
    // As doubles these two are the same number.
    expect(Number('9007199254740993')).toBe(Number('9007199254740992'))
    expect(plainNumber('9007199254740993')).toBe('9007199254740993')
    expect(plainNumber('9007199254740992')).toBe('9007199254740992')
    expect(plainNumber('12345678901234567890.123456789000')).toBe('12345678901234567890.123456789')
  })

  it('answers nothing for what it cannot compare digit by digit', () => {
    for (const other of ['1e3', '0x1F', '', '.', 'seven', '1,000', null]) expect(plainNumber(other)).toBeNull()
  })
})

describe('what goes to the clipboard', () => {
  it('is the value as it is shown', () => {
    expect(copyText(null)).toBe('NULL')
    expect(copyText(42)).toBe('42')
    expect(copyText('text')).toBe('text')
    expect(copyText({ type: 'binary', bytes: 4, preview: 'deadbeef' })).toBe('0xdeadbeef')
  })

  it('says so when only the start of a binary value is loaded', () => {
    const start = 'ab'.repeat(32)
    expect(copyText({ type: 'binary', bytes: 4096, preview: start })).toBe(
      `0x${start}… (the first 32 of 4,096 bytes)`,
    )
  })
})
