import { getCommand, type CanvasCommandId } from './canvasCommands';

export const CANVAS_HELP_CONTENT: Record<
  string,
  { title: string; body: string; shortcut?: string }
> = {
  'canvas-nav-overview': {
    title: 'Return to overview',
    body: 'Return to the board view from before you started browsing screens.',
  },
  'canvas-nav-up': {
    title: 'Up one level',
    body: 'Show the parent screen, or return to the overview from a top-level screen.',
  },
  'canvas-nav-previous': {
    title: 'Previous screen',
    body: 'Move the camera to the previous screen at this level.',
  },
  'canvas-nav-next': {
    title: 'Next screen',
    body: 'Move the camera to the next screen at this level. Choose Explore links to drill down.',
  },
  'canvas-tool-arrow-selector-tool': {
    title: 'Select cards',
    body: 'Select and move cards. Hold Shift to select more than one.',
    shortcut: 'V',
  },
  'canvas-tool-pan-tool': {
    title: 'Pan the board',
    body: 'Drag to move around the board. Hold Space to pan temporarily.',
    shortcut: 'H',
  },
  'canvas-tool-sticky-note-2': {
    title: 'Add a sticky note',
    body: 'Place a sticky note at the center of the view.',
    shortcut: 'N',
  },
  'canvas-tool-title': {
    title: 'Add text',
    body: 'Place a text card at the center of the view.',
    shortcut: 'T',
  },
  'canvas-tool-image': {
    title: 'Add an image',
    body: 'Add an image card to the board.',
  },
  'canvas-tool-crop-square': {
    title: 'Add a frame',
    body: 'Organize related cards inside a frame.',
    shortcut: 'F',
  },
  'canvas-tool-description': {
    title: 'Add a document',
    body: 'Choose an existing file or shared document to show on the board.',
  },
  'canvas-tool-add-comment': {
    title: 'Place a comment pin',
    body: 'Choose a point on the board to start a comment thread.',
    shortcut: 'M',
  },
  'canvas-tool-bookmark-add': {
    title: 'Save starting view',
    body: 'Save the current position and zoom as this board’s starting view.',
  },
  'canvas-zoom-map': {
    title: 'Toggle minimap',
    body: 'Show or hide the board overview used to navigate between cards.',
  },
  'canvas-zoom-remove': {
    title: 'Zoom out',
    body: 'Show more of the board.',
    shortcut: getCommand('zoom-out').shortcut,
  },
  'canvas-zoom-add': {
    title: 'Zoom in',
    body: 'See the cards in more detail.',
    shortcut: getCommand('zoom-in').shortcut,
  },
  'canvas-zoom-fit-screen': {
    title: 'Fit board',
    body: 'Fit every card into the current view.',
    shortcut: 'Shift+1',
  },
  'canvas-zoom-options': {
    title: 'Zoom and view options',
    body: 'Choose a zoom level, fit the selection, or toggle the grid and smart guides.',
  },
  'canvas-selection-align': {
    title: 'Align cards',
    body: 'Line up selected cards by their edges or centers.',
  },
  'canvas-selection-distribute': {
    title: 'Distribute cards',
    body: 'Space selected cards evenly horizontally or vertically.',
  },
  'canvas-selection-color': {
    title: 'Card color',
    body: 'Set a color for the selected notes, text cards, or frames.',
  },
  'canvas-selection-comment': {
    title: 'Comment on card',
    body: 'Start or view the comment thread for this card.',
  },
  'canvas-selection-history': {
    title: 'Card history',
    body: 'Browse revisions of the document shown in this card.',
  },
};

const commandBodies: Partial<Record<CanvasCommandId, string>> = {
  tidy: 'Arrange selected cards into a tidy grid.',
  group: 'Group selected cards so they can be selected and moved together.',
  ungroup: 'Let cards in the selected group be selected and moved separately.',
  lock: 'Prevent selected cards from being moved or resized.',
  unlock: 'Allow selected cards to be moved and resized again.',
  duplicate: 'Create copies of the selected cards.',
  'bring-front': 'Place selected cards in front of overlapping cards.',
  'send-back': 'Place selected cards behind overlapping cards.',
  delete: 'Remove the selection from this board. Referenced files are kept.',
};
for (const [id, body] of Object.entries(commandBodies)) {
  const command = getCommand(id as CanvasCommandId);
  CANVAS_HELP_CONTENT[`canvas-command-${id}`] = {
    title: command.label,
    body,
    ...(command.shortcut
      ? { shortcut: command.shortcut.replace('Mod', 'Cmd') }
      : {}),
  };
}
