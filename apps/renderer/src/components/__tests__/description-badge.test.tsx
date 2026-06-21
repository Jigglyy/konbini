import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { CardView } from '@kanbini/shared'
import { DescriptionBadge } from '../description-badge'

function makeCard(description: string | null): CardView {
  return {
    id: 'c1',
    title: 'Card',
    description,
    position: 'a',
    completed: false,
    dueAt: null,
    priority: null,
    labelIds: [],
    checklists: [],
    comments: [],
    attachments: [],
    coverAttachmentId: null,
    activities: []
  }
}

describe('<DescriptionBadge>', () => {
  it('shows a marker when the card has a description', () => {
    render(<DescriptionBadge card={makeCard('Some notes')} />)
    expect(screen.getByTitle('Has a description')).toBeInTheDocument()
  })

  it('renders nothing when the card has no description', () => {
    render(<DescriptionBadge card={makeCard(null)} />)
    expect(screen.queryByTitle('Has a description')).toBeNull()
  })

  it('renders nothing for a whitespace-only description', () => {
    render(<DescriptionBadge card={makeCard('   \n  ')} />)
    expect(screen.queryByTitle('Has a description')).toBeNull()
  })
})
