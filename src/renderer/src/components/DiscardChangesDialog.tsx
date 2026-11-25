import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { plural } from '@/lib/format'
import { useStore } from '@/store'

/**
 * Asks before something would throw work away: changes that were made in a grid
 * and not saved, or a transaction that closing the tab would roll back.
 */
export function DiscardChangesDialog() {
  const prompt = useStore((state) => state.discardPrompt)
  const { answerDiscard } = useStore.getState()
  const changes = prompt?.changes ?? 0
  const transaction = prompt?.transaction ?? false

  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => !open && answerDiscard(false)}>
      <DialogContent className="w-[400px] p-4">
        <DialogTitle>
          {changes > 0 ? `Discard ${plural(changes, 'unsaved change')}?` : 'Close this tab and roll back its transaction?'}
        </DialogTitle>
        <DialogDescription className="mt-1.5">
          {changes > 0 &&
            (prompt?.reason === 'close'
              ? 'Closing this tab throws away the changes you made in its results and have not saved. '
              : 'Running a statement replaces these results, and the changes you have not saved go with them. ')}
          {transaction
            ? `This tab ${changes > 0 ? 'also ' : ''}has a transaction open. Closing the tab ends it, and the database ` +
              'takes back everything it changed and has not committed.'
            : 'The database is not touched either way.'}
        </DialogDescription>
        <div className="mt-4 flex justify-end gap-2">
          <Button size="lg" onClick={() => answerDiscard(false)}>
            {changes > 0 ? 'Keep editing' : 'Keep the tab'}
          </Button>
          <Button size="lg" variant="danger" onClick={() => answerDiscard(true)}>
            {transaction ? 'Close and roll back' : 'Discard changes'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
