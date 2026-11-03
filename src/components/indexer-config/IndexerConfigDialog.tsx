import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface IndexerConfigDialogProps {
  /** Indexer id, e.g. "rutracker". `null` = closed. */
  indexerId: string | null;
  /** Display name for the title while the config loads. */
  indexerName?: string;
  /** true when the indexer is not configured yet (dialog acts as "add"). */
  isNew?: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful save (the indexer is now configured). */
  onSaved?: (indexerId: string) => void;
}

// Placeholder with the final props: implemented by the "indexer config form" task.
export function IndexerConfigDialog({ indexerId, indexerName, onOpenChange }: IndexerConfigDialogProps) {
  return (
    <Dialog open={indexerId !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{indexerName ?? indexerId}</DialogTitle>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
