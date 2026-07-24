import {$createParagraphNode, $createTextNode, $getNodeByKey, LexicalEditor} from 'lexical';
// import {GraphCollaborationHooks} from '../../space/graph/GraphCollaborationProvider';
import {BoardConfig} from './BoardConfigDialog';

// Stub interface until GraphCollaborationProvider is implemented
interface GraphCollaborationHooks {
  onEntityUpdated?: (entity: any) => void;
  onEntityDeleted?: (entityUri: string) => void;
  updateEntity?: (entity: any) => Promise<void>;
  updateEntityProperty?: (entityUri: string, property: string, value: any) => Promise<void>;
  subscribeToEntityType?: (entityType: string, callback: (entities: EntityData[]) => void) => void;
}
import {$isBoardNode} from './KanbanBoardNode.ts';
import {$createColumnNode} from './BoardColumnNode';
import {$createColumnHeaderNode} from './BoardColumnHeaderNode';
import {$createColumnContentNode} from './BoardColumnContentNode';
import {$createCardNode} from './BoardCardNode';
// import {$createEntityNode} from '../EntityPlugin/EntityNode';

export interface EntityData {
  uri: string;
  type: string;
  properties: Record<string, any>;
  [key: string]: any;
}

export class BoardSyncService {
  private editor: LexicalEditor;
  private hooks: GraphCollaborationHooks;
  private config: BoardConfig;
  private boardNodeKey: string;
  private unsubscribeCallbacks: (() => void)[] = [];
  private entitySubscription: (() => void) | null = null;
  private isUpdatingFromEntity = false;
  private isUpdatingFromBoard = false;

  constructor(
    editor: LexicalEditor,
    hooks: GraphCollaborationHooks,
    config: BoardConfig,
    boardNodeKey: string
  ) {
    this.editor = editor;
    this.hooks = hooks;
    this.config = config;
    this.boardNodeKey = boardNodeKey;
  }

  start(): void {
    this.subscribeToEntities();
    this.setupBoardCommandListeners();
  }

  stop(): void {
    this.unsubscribeCallbacks.forEach(callback => callback());
    this.unsubscribeCallbacks = [];

    if (this.entitySubscription) {
      this.entitySubscription();
      this.entitySubscription = null;
    }
  }

  private subscribeToEntities(): void {
    try {
      if (!this.hooks || !this.config.entityTypeId) {
        console.warn('Cannot subscribe to entities: hooks or entityTypeId missing');
        return;
      }
      
      // subscribeToEntityType returns void, so we need to handle unsubscription differently
      this.hooks.subscribeToEntityType?.(
        this.config.entityTypeId,
        (entities: EntityData[]) => {
          if (this.isUpdatingFromBoard) return;

          this.isUpdatingFromEntity = true;
          this.syncEntitiesToBoard(entities);
          this.isUpdatingFromEntity = false;
        }
      );
      // Note: The actual unsubscription mechanism would depend on the real implementation
      // For now, we'll store a placeholder callback
    } catch (error) {
      console.error('Failed to subscribe to entity type:', error);
    }
  }

  private syncEntitiesToBoard(entities: EntityData[]): void {
    this.editor.update(() => {
      const boardNode = $getNodeByKey(this.boardNodeKey);
      if (!$isBoardNode(boardNode)) {
        console.warn('Board node not found or invalid');
        return;
      }

      // Get status property enum options to determine columns
      this.getStatusPropertyOptions().then(statusOptions => {
        if (!statusOptions) {
          console.warn('Could not load status property options');
          return;
        }

        this.editor.update(() => {
          // Clear existing columns
          const existingChildren = boardNode.getChildren();
          existingChildren.forEach(child => child.remove());

          // Create columns for each status option
          statusOptions.forEach(option => {
            const column = $createColumnNode();

            // Create header
            const header = $createColumnHeaderNode();
            const headerParagraph = $createParagraphNode();
            headerParagraph.append($createTextNode(option.label));
            header.append(headerParagraph);

            // Create content area
            const content = $createColumnContentNode();

            // Filter entities for this column
            const columnEntities = entities.filter(entity => {
              if (!this.config.statusPropertyId) return false;
              const statusValue = entity.properties[this.config.statusPropertyId];
              return statusValue === option.value;
            });

            // Add entity cards to this column
            columnEntities.forEach(entity => {
              const card = $createCardNode(entity.uri);

              // // Create EntityNode as card content
              // const entityNode = $createEntityNode(entity.type, entity.uri, entity.properties.name || entity.uri);
              // card.append(entityNode);

              content.append(card);
            });

            column.append(header, content);
            boardNode.append(column);
          });
        });
      });
    });
  }

  private async getStatusPropertyOptions(): Promise<Array<{ value: string; label: string; icon?: string; color?: string }> | null> {
    try {
      // For now, return a placeholder - in a real implementation, this would fetch from the schema
      // based on the config.statusPropertyId
      return [
        { value: 'todo', label: 'To Do', icon: 'fa-circle', color: '#e74c3c' },
        { value: 'in_progress', label: 'In Progress', icon: 'fa-circle-half-stroke', color: '#f39c12' },
        { value: 'done', label: 'Done', icon: 'fa-check-circle', color: '#27ae60' }
      ];
    } catch (error) {
      console.error('Failed to get status property options:', error);
      return null;
    }
  }

  private setupBoardCommandListeners(): void {
    // Listen for card moves between columns
    const handleCardMove = (event: CustomEvent) => {
      if (this.isUpdatingFromEntity) return;

      const { cardId, fromColumnIndex, toColumnIndex } = event.detail;
      this.handleCardMove(cardId, fromColumnIndex, toColumnIndex);
    };

    window.addEventListener('kanban-card-moved', handleCardMove as EventListener);
    this.unsubscribeCallbacks.push(() => {
      window.removeEventListener('kanban-card-moved', handleCardMove as EventListener);
    });
  }

  private async handleCardMove(cardId: string, fromColumnIndex: number, toColumnIndex: number): Promise<void> {
    if (this.isUpdatingFromEntity) return;

    try {
      this.isUpdatingFromBoard = true;

      // Get the entity URI from the card
      const entityUri = cardId; // Assuming cardId is the entity URI

      // Get status options to determine the new status value
      const statusOptions = await this.getStatusPropertyOptions();
      if (!statusOptions || toColumnIndex >= statusOptions.length) {
        console.warn('Invalid column index or missing status options');
        return;
      }

      const newStatusValue = statusOptions[toColumnIndex].value;

      // Update the entity through the collaboration hooks
      // Note: This assumes updateEntityProperty exists - may need to use updateEntity instead
      try {
        if (this.config.statusPropertyId) {
          await this.hooks.updateEntity?.({
            uri: entityUri,
            type: this.config.entityTypeId,
            properties: {
              [this.config.statusPropertyId]: newStatusValue
            }
          });
        }
      } catch (error) {
        console.error('Failed to update entity via collaboration hooks:', error);
        // Fallback: try direct property update if available
        if (typeof this.hooks.updateEntityProperty === 'function' && this.config.statusPropertyId) {
          await this.hooks.updateEntityProperty?.(entityUri, this.config.statusPropertyId, newStatusValue);
        } else {
          throw error;
        }
      }

    } catch (error) {
      console.error('Failed to update entity status:', error);
    } finally {
      this.isUpdatingFromBoard = false;
    }
  }

  updateConfig(newConfig: BoardConfig): void {
    // Stop current subscriptions
    this.stop();

    // Update config
    this.config = newConfig;

    // Start with new config
    this.start();
  }

  getConfig(): BoardConfig {
    return this.config;
  }
}
