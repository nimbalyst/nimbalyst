import React from 'react';
import type { FieldDefinition } from '../../../../runtime/src/plugins/TrackerPlugin/models/TrackerDataModel';
import { type TeamMemberOption } from '../../../../runtime/src/plugins/TrackerPlugin/components/TrackerFieldEditor';
export declare function TrackerPhoneProperties({ fields, values, editing, onChange, teamMembers }: {
    fields: FieldDefinition[];
    values: Record<string, unknown>;
    editing: boolean;
    onChange?: (name: string, value: unknown) => void | Promise<unknown>;
    teamMembers?: TeamMemberOption[];
}): React.JSX.Element;
