/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX} from 'react';

import {ContentEditable} from '@lexical/react/LexicalContentEditable';

type Props = {
  className?: string;
  placeholderClassName?: string;
  placeholder: string;
};

export default function LexicalContentEditable({
  className,
  placeholder,
  placeholderClassName,
}: Props): JSX.Element {
  return (
    <ContentEditable
      className={className ?? 'ContentEditable__root border-0 text-[15px] block relative outline-none py-2 px-[46px] pb-[400px] min-h-[150px] max-[1025px]:px-2'}
      aria-placeholder={placeholder}
      placeholder={
        <div className={placeholderClassName ?? 'ContentEditable__placeholder text-[15px] text-nim-faint overflow-hidden absolute text-ellipsis top-2 left-[46px] right-7 select-none whitespace-nowrap inline-block pointer-events-none max-[1025px]:left-2 max-[1025px]:right-2'}>
          {placeholder}
        </div>
      }
    />
  );
}
