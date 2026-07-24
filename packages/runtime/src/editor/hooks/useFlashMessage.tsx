/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  type ShowFlashMessage,
  useFlashMessageContext,
} from '../context/FlashMessageContext';

function useFlashMessage(): ShowFlashMessage {
  return useFlashMessageContext();
}

export default useFlashMessage;
export { useFlashMessage };
