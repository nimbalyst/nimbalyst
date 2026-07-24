import { useState, useEffect } from 'react';
import { CardData } from './BoardCardNode';

interface CardEditDialogProps {
  visible: boolean;
  onHide: () => void;
  onSave: (data: CardData) => void;
  initialData: CardData;
}

export function CardEditDialog({ visible, onHide, onSave, initialData }: CardEditDialogProps) {
  const [title, setTitle] = useState(initialData.title || '');
  const [owner, setOwner] = useState(initialData.owner || '');
  const [dueDate, setDueDate] = useState(initialData.dueDate || '');
  const [priority, setPriority] = useState(initialData.priority || 'medium');
  const [description, setDescription] = useState(initialData.description || '');

  // Update form when initialData changes
  useEffect(() => {
    if (visible) {
      setTitle(initialData.title || '');
      setOwner(initialData.owner || '');
      setDueDate(initialData.dueDate || '');
      setPriority(initialData.priority || 'medium');
      setDescription(initialData.description || '');
    }
  }, [visible, initialData]);

  // Handle escape key to close dialog
  useEffect(() => {
    if (!visible) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onHide();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [visible, onHide]);

  if (!visible) return null;

  const handleSave = () => {
    const data: CardData = {
      title: title || 'Untitled',
      owner: owner || undefined,
      dueDate: dueDate || undefined,
      priority: priority as 'low' | 'medium' | 'high',
      description: description || undefined,
    };
    onSave(data);
    onHide();
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleSave();
    }
  };

  return (
    <div className="card-edit-overlay fixed inset-0 bg-black/50 flex items-center justify-center z-[10000]" onClick={handleOverlayClick}>
      <div className="card-edit-dialog bg-[var(--nim-bg-secondary)] p-6 rounded-lg min-w-[400px] max-w-[500px] max-h-[80vh] overflow-auto shadow-[0_4px_16px_rgba(0,0,0,0.3)]">
        <h3 className="card-edit-title m-0 mb-5 text-lg font-semibold text-[var(--nim-text)]">Edit Card</h3>

        <div className="card-edit-field mb-4">
          <label className="card-edit-label block mb-1 text-sm font-medium text-[var(--nim-text)]">
            Title
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="card-edit-input w-full p-2 border border-[var(--nim-border)] rounded text-sm bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] box-border font-inherit focus:outline-none focus:border-[var(--nim-border-focus)]"
            placeholder="Card title"
          />
        </div>

        <div className="card-edit-field mb-4">
          <label className="card-edit-label block mb-1 text-sm font-medium text-[var(--nim-text)]">
            Owner
          </label>
          <input
            type="text"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="card-edit-input w-full p-2 border border-[var(--nim-border)] rounded text-sm bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] box-border font-inherit focus:outline-none focus:border-[var(--nim-border-focus)]"
            placeholder="Assigned to"
          />
        </div>

        <div className="card-edit-field mb-4">
          <label className="card-edit-label block mb-1 text-sm font-medium text-[var(--nim-text)]">
            Due Date
          </label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="card-edit-input w-full p-2 border border-[var(--nim-border)] rounded text-sm bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] box-border font-inherit focus:outline-none focus:border-[var(--nim-border-focus)]"
          />
        </div>

        <div className="card-edit-field mb-4">
          <label className="card-edit-label block mb-1 text-sm font-medium text-[var(--nim-text)]">
            Priority
          </label>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as 'low' | 'medium' | 'high')}
            className="card-edit-select w-full p-2 border border-[var(--nim-border)] rounded text-sm bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] box-border font-inherit focus:outline-none focus:border-[var(--nim-border-focus)]"
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>

        <div className="card-edit-field mb-4">
          <label className="card-edit-label block mb-1 text-sm font-medium text-[var(--nim-text)]">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="card-edit-textarea w-full p-2 border border-[var(--nim-border)] rounded text-sm bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] box-border font-inherit min-h-[80px] resize-y focus:outline-none focus:border-[var(--nim-border-focus)]"
            placeholder="Add a description..."
          />
        </div>

        <div className="card-edit-actions flex gap-2.5 justify-end mt-5 border-t border-[var(--nim-border)] pt-4">
          <button
            onClick={handleSave}
            className="card-edit-button card-edit-button-save py-2 px-4 rounded cursor-pointer text-sm transition-all font-inherit bg-[var(--nim-primary)] border border-[var(--nim-primary)] text-white hover:bg-[var(--nim-primary-hover)]"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}