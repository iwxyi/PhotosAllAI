import type { ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';

export function ToolbarCustomizeRow({ id, label, children }: { id: string; label: string; children: ReactNode }): React.JSX.Element {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  return <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition, zIndex: isDragging ? 1 : undefined }} className={`toolbar-customize-row${isDragging ? ' is-dragging' : ''}`} data-layout-id={id}>
    <button type="button" ref={setActivatorNodeRef} className="toolbar-drag-handle" {...attributes} {...listeners} aria-label={`拖动排序${label}`} title="拖动排序"><GripVertical size={14} /></button>
    {children}
  </div>;
}
