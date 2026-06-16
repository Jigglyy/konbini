import { useState } from 'react'
import type {
  BoardView,
  ListOnEnterRule,
  ListSortMode,
  ListView,
  Mutation
} from '@kanbini/shared'
import type { Optimistic } from '../hooks/useBoardMutation'
import { swatchOptions } from '../lib/palette'
import { cn } from '../lib/utils'
import { MenuLabel, MenuSep } from './ui/context-menu'

// List editor body - rendered inside a ContextMenu (pencil button or
// right-click on the list header, wired in board.tsx).

type Apply = (m: Mutation, o: Optimistic) => void

const patchList = (
  b: BoardView,
  id: string,
  patch: Partial<ListView>
): BoardView => ({
  ...b,
  lists: b.lists.map((l) => (l.id === id ? { ...l, ...patch } : l))
})

// Sort modes offered in the "Sort cards" picker (ADR-0032 + follow-up).
// `mode` maps to list.sortMode (null = Manual, the fractional-index
// default). `full` spans both columns (Manual sits on its own row). The
// hint distinguishes "created" (when the card was made) from "added to
// list" (when it entered THIS list) - the two read similarly otherwise.
const SORT_OPTIONS: ReadonlyArray<{
  label: string
  mode: ListSortMode | null
  hint: string
  full?: boolean
}> = [
  { label: 'Manual', mode: null, hint: 'Drag cards to arrange them yourself', full: true },
  {
    label: 'Newest created',
    mode: 'created-desc',
    hint: 'By when the card was created, newest first'
  },
  {
    label: 'Oldest created',
    mode: 'created-asc',
    hint: 'By when the card was created, oldest first'
  },
  {
    label: 'Recently added',
    mode: 'added-desc',
    hint: 'By when the card was added to this list, newest first'
  },
  {
    label: 'First added',
    mode: 'added-asc',
    hint: 'By when the card was added to this list, oldest first'
  },
  {
    label: 'Due date',
    mode: 'due-asc',
    hint: 'Soonest due first; cards with no due date last'
  },
  {
    label: 'Priority',
    mode: 'priority-desc',
    hint: 'Urgent first, unprioritised last'
  },
  { label: 'A to Z', mode: 'title-asc', hint: 'By title, A to Z' },
  { label: 'Z to A', mode: 'title-desc', hint: 'By title, Z to A' }
]

export function ListEditor({
  list,
  apply,
  close,
  onSaveAsTemplate,
  onMove,
  canMoveLeft,
  canMoveRight
}: {
  list: ListView
  apply: Apply
  close: () => void
  /** Opens the save-as-template dialog (the host owns it because the
   *  Modal must outlive the ContextMenu, which unmounts on close). */
  onSaveAsTemplate?: () => void
  /** Reorder this list left (-1) / right (+1). The keyboard / no-pointer
   *  fallback for the header grip drag (mirrors the label bar editor).
   *  Omitted where reordering isn't available; the booleans hide the
   *  end-of-row direction. */
  onMove?: (dir: -1 | 1) => void
  canMoveLeft?: boolean
  canMoveRight?: boolean
}) {
  const [name, setName] = useState(list.name)
  const [wip, setWip] = useState(list.wipLimit?.toString() ?? '')
  const [confirming, setConfirming] = useState(false)

  const rename = (): void => {
    const n = name.trim()
    if (!n || n === list.name) return
    apply({ type: 'list.update', id: list.id, patch: { name: n } }, (b) =>
      patchList(b, list.id, { name: n })
    )
  }
  const commitWip = (): void => {
    const raw = wip.trim()
    const next = raw === '' ? null : Math.trunc(Number(raw))
    // Reject NaN / non-positive - restore the field to the saved value.
    if (next !== null && (!Number.isFinite(next) || next < 1)) {
      setWip(list.wipLimit?.toString() ?? '')
      return
    }
    if (next === list.wipLimit) return
    apply(
      { type: 'list.update', id: list.id, patch: { wipLimit: next } },
      (b) => patchList(b, list.id, { wipLimit: next })
    )
  }
  const setColor = (color: string | null): void => {
    // No-op if it's already this colour (e.g. clicking the ring'd
    // current swatch, including the orphaned-colour one swatchOptions
    // surfaces) - avoids a redundant mutation + junk undo entry.
    if (color === list.color) {
      close()
      return
    }
    apply({ type: 'list.update', id: list.id, patch: { color } }, (b) =>
      patchList(b, list.id, { color })
    )
    close()
  }
  const del = (): void => {
    apply({ type: 'list.delete', id: list.id }, (b) => ({
      ...b,
      lists: b.lists.filter((l) => l.id !== list.id)
    }))
    close()
  }

  return (
    <>
      <MenuLabel>Rename</MenuLabel>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            rename()
            close()
          }
        }}
        onBlur={rename}
        className="mx-1 rounded border border-border bg-background px-2 py-1 text-sm focus:border-ring focus:outline-none"
      />
      {onMove && (
        <>
          <MenuSep />
          <MenuLabel>Move</MenuLabel>
          <div className="flex gap-1 px-2 py-1">
            <button
              disabled={!canMoveLeft}
              onClick={() => {
                onMove(-1)
                close()
              }}
              className="flex-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
            >
              ← Left
            </button>
            <button
              disabled={!canMoveRight}
              onClick={() => {
                onMove(1)
                close()
              }}
              className="flex-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
            >
              Right →
            </button>
          </div>
        </>
      )}
      <MenuSep />
      <MenuLabel>Colour</MenuLabel>
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1">
        {swatchOptions(list.color).map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            className={`size-5 rounded-full ${list.color === c ? 'ring-2 ring-ring' : ''}`}
            style={{ backgroundColor: c }}
            aria-label={`Colour ${c}`}
          />
        ))}
        <button
          onClick={() => setColor(null)}
          className="ml-1 text-xs text-muted-foreground hover:text-foreground"
        >
          None
        </button>
      </div>
      <MenuSep />
      <MenuLabel>Sort cards</MenuLabel>
      <div className="grid grid-cols-2 gap-1 px-2 py-1">
        {SORT_OPTIONS.map(({ label, mode, hint, full }) => {
          const active = (list.sortMode ?? null) === mode
          return (
            <button
              key={label}
              title={hint}
              onClick={() => {
                if (active) {
                  close()
                  return
                }
                apply(
                  {
                    type: 'list.update',
                    id: list.id,
                    patch: { sortMode: mode }
                  },
                  (b) => patchList(b, list.id, { sortMode: mode })
                )
                close()
              }}
              className={cn(
                'rounded px-2 py-1 text-xs',
                full && 'col-span-2',
                active
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {label}
            </button>
          )
        })}
      </div>
      <MenuSep />
      <MenuLabel>On card enter</MenuLabel>
      <div className="grid grid-cols-3 gap-1 px-2 py-1">
        {(
          [
            ['None', null],
            ['Complete', { kind: 'complete' }],
            ['Uncomplete', { kind: 'uncomplete' }]
          ] as Array<[string, ListOnEnterRule | null]>
        ).map(([label, rule]) => {
          const active =
            (list.onEnter?.kind ?? null) === (rule?.kind ?? null)
          return (
            <button
              key={label}
              onClick={() => {
                if (active) {
                  close()
                  return
                }
                apply(
                  {
                    type: 'list.update',
                    id: list.id,
                    patch: { onEnter: rule }
                  },
                  (b) => patchList(b, list.id, { onEnter: rule })
                )
                close()
              }}
              className={cn(
                'rounded px-2 py-1 text-xs',
                active
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {label}
            </button>
          )
        })}
      </div>
      <MenuSep />
      <MenuLabel>Card limit</MenuLabel>
      <div className="flex items-center gap-2 px-2 py-1">
        <input
          type="number"
          min="1"
          value={wip}
          onChange={(e) => setWip(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitWip()
              close()
            }
          }}
          placeholder="None"
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm focus:border-ring focus:outline-none"
        />
        <button
          onClick={() => {
            commitWip()
            close()
          }}
          className="shrink-0 rounded bg-muted px-2.5 py-1 text-sm hover:bg-accent hover:text-accent-foreground"
        >
          Set
        </button>
      </div>
      {onSaveAsTemplate && (
        <>
          <MenuSep />
          <button
            onClick={() => {
              onSaveAsTemplate()
              close()
            }}
            className="rounded px-2 py-1.5 text-left text-sm text-foreground hover:bg-muted"
          >
            Save as template…
          </button>
        </>
      )}
      <MenuSep />
      {confirming ? (
        <div className="flex flex-col gap-1 px-1">
          <span className="px-1 text-xs text-muted-foreground">
            Delete “{list.name}” and its {list.cards.length} card
            {list.cards.length === 1 ? '' : 's'}? You can undo this with Ctrl+Z.
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setConfirming(false)}
              className="flex-1 rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Cancel
            </button>
            <button
              onClick={del}
              className="flex-1 rounded bg-red-500/90 px-2 py-1.5 text-sm text-white hover:bg-red-500"
            >
              Delete
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          className="rounded px-2 py-1.5 text-left text-sm text-red-400 hover:bg-muted hover:text-red-300"
        >
          Delete list
        </button>
      )}
    </>
  )
}
