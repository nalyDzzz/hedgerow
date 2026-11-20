import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { plural } from '@/lib/format'
import { useStore } from '@/store'

/** Asks before something would throw away changes that were made in a grid and not saved. */
export function DiscardChangesDialog() {
  const prompt = useStore((state) => state.discardPrompt)
  const { answerDiscard } = useStore.getState()

  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => !open && answerDiscard(false)}>
      <DialogContent className="w-[400px] p-4">
        <DialogTitle>Discard {plural(prompt?.changes ?? 0, 'unsaved change')}?</DialogTitle>
        <DialogDescription className="mt-1.5">
          {prompt?.reason === 'close'
            ? 'Closing this tab throws away the changes you made in its results and have not saved.'
            : 'Running a statement replaces these results, and the changes you have not saved go with them.'}{' '}
          The database is not touched either way.
        </DialogDescription>
        <div className="mt-4 flex justify-end gap-2">
          <Button size="lg" onClick={() => answerDiscard(false)}>
            Keep editing
          </Button>
          <Button size="lg" variant="danger" onClick={() => answerDiscard(true)}>
            Discard changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
