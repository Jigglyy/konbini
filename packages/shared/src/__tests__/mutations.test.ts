import { describe, expect, it } from 'vitest'
import { zChangeEvent, zMutation, zMutationResult } from '../mutations'

// One representative valid example per discriminated-union arm - the
// parse exercises each arm's schema. Also a handful of must-reject
// cases for the rules the renderer + main rely on (non-empty title,
// non-empty name, integer dueAt, positive wipLimit, …).

const validExamples = [
  { type: 'project.create' as const, name: 'P' },
  { type: 'project.update' as const, id: 'p1', patch: { name: 'Renamed' } },
  { type: 'project.delete' as const, id: 'p1' },
  { type: 'board.create' as const, name: 'B', projectId: 'p1' },
  { type: 'board.create' as const, name: 'B' }, // projectId omitted
  {
    type: 'board.update' as const,
    id: 'b1',
    patch: { name: 'Renamed', pinned: true }
  },
  { type: 'board.delete' as const, id: 'b1' },
  {
    type: 'board.move' as const,
    id: 'b1',
    beforeId: 'b2',
    afterId: 'b3'
  },
  { type: 'board.duplicate' as const, id: 'b1' },
  { type: 'list.create' as const, boardId: 'b1', name: 'L' },
  {
    type: 'list.update' as const,
    id: 'l1',
    patch: { wipLimit: 5, closed: false }
  },
  { type: 'list.delete' as const, id: 'l1' },
  { type: 'list.move' as const, id: 'l1', beforeId: 'l2', afterId: 'l3' },
  { type: 'card.create' as const, listId: 'l1', title: 'T' },
  {
    type: 'card.update' as const,
    id: 'c1',
    patch: {
      title: 'New',
      description: null,
      dueAt: 1700000000000,
      completed: true,
      coverAttachmentId: null,
      priority: 'high' as const
    }
  },
  // ADR-0037 - null clears priority; ensure the optional+nullable shape
  // accepts both a value and an explicit null.
  {
    type: 'card.update' as const,
    id: 'c2',
    patch: { priority: null }
  },
  { type: 'card.delete' as const, id: 'c1' },
  {
    type: 'card.setLabels' as const,
    id: 'c1',
    labelIds: ['lab1', 'lab2']
  },
  {
    type: 'card.move' as const,
    id: 'c1',
    toListId: 'l2',
    beforeId: null,
    afterId: null
  },
  {
    type: 'label.create' as const,
    boardId: 'b1',
    name: 'bug',
    color: '#ff0000'
  },
  {
    type: 'label.update' as const,
    id: 'lab1',
    patch: { name: 'bugged' }
  },
  { type: 'label.delete' as const, id: 'lab1' },
  { type: 'checklist.create' as const, cardId: 'c1', name: 'Subtasks' },
  {
    type: 'checklist.update' as const,
    id: 'cl1',
    patch: { name: 'Renamed' }
  },
  { type: 'checklist.delete' as const, id: 'cl1' },
  {
    type: 'checklistItem.create' as const,
    checklistId: 'cl1',
    text: 'todo'
  },
  {
    type: 'checklistItem.update' as const,
    id: 'ci1',
    patch: { completed: true }
  },
  { type: 'checklistItem.delete' as const, id: 'ci1' },
  {
    type: 'checklistItem.move' as const,
    id: 'ci1',
    toChecklistId: 'cl1',
    beforeId: null,
    afterId: null
  },
  {
    type: 'comment.create' as const,
    cardId: 'c1',
    body: 'hi',
    author: 'ai'
  },
  { type: 'comment.create' as const, cardId: 'c1', body: 'hi' }, // human
  {
    type: 'comment.update' as const,
    id: 'cm1',
    patch: { body: 'edited' }
  },
  { type: 'comment.delete' as const, id: 'cm1' },
  { type: 'attachment.delete' as const, id: 'att1' }
]

describe('zMutation - every arm', () => {
  it.each(validExamples.map((m) => [m.type, m] as const))(
    '%s parses',
    (_type, example) => {
      const parsed = zMutation.parse(example)
      expect(parsed.type).toBe(example.type)
    }
  )

  it('rejects an unknown discriminator', () => {
    expect(() =>
      zMutation.parse({ type: 'card.teleport', id: 'c1' })
    ).toThrow()
  })

  it('rejects empty card title', () => {
    expect(() =>
      zMutation.parse({ type: 'card.create', listId: 'l1', title: '' })
    ).toThrow()
  })

  it('rejects empty card.update title in patch', () => {
    expect(() =>
      zMutation.parse({ type: 'card.update', id: 'c1', patch: { title: '' } })
    ).toThrow()
  })

  it('rejects zero / negative wipLimit', () => {
    expect(() =>
      zMutation.parse({
        type: 'list.update',
        id: 'l1',
        patch: { wipLimit: 0 }
      })
    ).toThrow()
    expect(() =>
      zMutation.parse({
        type: 'list.update',
        id: 'l1',
        patch: { wipLimit: -1 }
      })
    ).toThrow()
  })

  it('rejects non-integer dueAt', () => {
    expect(() =>
      zMutation.parse({
        type: 'card.update',
        id: 'c1',
        patch: { dueAt: 1.5 }
      })
    ).toThrow()
  })

  it('accepts null wipLimit (clear the limit)', () => {
    const parsed = zMutation.parse({
      type: 'list.update',
      id: 'l1',
      patch: { wipLimit: null }
    })
    expect(parsed.type).toBe('list.update')
  })
})

describe('zMutationResult / zChangeEvent', () => {
  it('round-trips a mutation result', () => {
    const out = zMutationResult.parse({ id: 'c1', boardId: 'b1' })
    expect(out).toEqual({ id: 'c1', boardId: 'b1' })
  })

  it('allows null boardId (board-agnostic change)', () => {
    expect(zChangeEvent.parse({ boardId: null }).boardId).toBeNull()
  })
})
