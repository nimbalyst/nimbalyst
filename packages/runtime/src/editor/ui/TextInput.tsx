/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX} from 'react';

import {HTMLInputTypeAttribute} from 'react';

type Props = Readonly<{
  'data-test-id'?: string;
  label: string;
  onChange: (val: string) => void;
  placeholder?: string;
  value: string;
  type?: HTMLInputTypeAttribute;
}>;

export default function TextInput({
  label,
  value,
  onChange,
  placeholder = '',
  'data-test-id': dataTestId,
  type = 'text',
}: Props): JSX.Element {
  return (
    <div className="Input__wrapper flex flex-row items-center mb-[10px]">
      <label className="Input__label flex flex-1 text-nim-muted">
        {label}
      </label>
      <input
        type={type}
        className="Input__input flex flex-[2] border border-nim py-[7px] px-[10px] text-base rounded-[5px] min-w-0 bg-nim-secondary text-nim placeholder:text-nim-muted dark:[color-scheme:dark]"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        data-test-id={dataTestId}
      />
    </div>
  );
}
