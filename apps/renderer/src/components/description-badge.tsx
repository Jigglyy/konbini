import { AlignLeft } from 'lucide-react'
import type { CardView } from '@kanbini/shared'

// Small marker on a card preview that signals the card has a description.
// A card without one (description null, or whitespace-only) renders nothing,
// so its look stays exactly as before - no mark. Mirrors PriorityBadge /
// DueBadge in the card's meta row.
export function DescriptionBadge({ card }: { card: CardView }) {
  if (!card.description?.trim()) return null
  return (
    <span
      className="flex items-center text-muted-foreground"
      title="Has a description"
    >
      <AlignLeft className="size-3.5" />
    </span>
  )
}
