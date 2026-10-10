package com.nimbalyst.app.ui.sessiondetail

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import com.nimbalyst.app.R
import com.nimbalyst.app.attachments.AttachmentStore

/** The "+" sheet's attachment sources. */
class AttachmentLaunchers(
    val pickPhotos: () -> Unit,
    val takePhoto: () -> Unit,
    val paste: () -> Unit,
)

@Composable
fun rememberAttachmentLaunchers(viewModel: SessionDetailViewModel): AttachmentLaunchers {
    val context = LocalContext.current

    val photoPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(SessionDetailViewModel.MAX_ATTACHMENTS)
    ) { uris -> viewModel.addImages(uris) }

    // TakePicture writes the full-resolution image to our FileProvider URI,
    // unlike TakePicturePreview's thumbnail. The target path is kept in saved
    // state because the camera app can outlive this process.
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { captured ->
        viewModel.onCameraResult(captured)
    }
    val launchCamera = {
        val file = viewModel.prepareCameraCapture()
        try {
            camera.launch(AttachmentStore.uriForCameraFile(context, file))
        } catch (_: ActivityNotFoundException) {
            // No app handles ACTION_IMAGE_CAPTURE (no camera, or it is disabled).
            viewModel.onCameraResult(false)
            Toast.makeText(context, R.string.camera_app_unavailable, Toast.LENGTH_SHORT).show()
        }
    }
    // The manifest declares CAMERA for the QR scanner, which makes the capture
    // intent require the grant too.
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            launchCamera()
        } else {
            Toast.makeText(context, R.string.session_detail_camera_permission_denied, Toast.LENGTH_SHORT).show()
        }
    }

    fun withSlot(action: () -> Unit) {
        if (viewModel.remainingAttachmentSlots > 0) {
            action()
        } else {
            val message = context.getString(R.string.session_detail_attachment_limit, SessionDetailViewModel.MAX_ATTACHMENTS)
            Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
        }
    }

    return AttachmentLaunchers(
        pickPhotos = {
            withSlot {
                photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            }
        },
        takePhoto = {
            withSlot {
                val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                    PackageManager.PERMISSION_GRANTED
                if (granted) launchCamera() else cameraPermission.launch(Manifest.permission.CAMERA)
            }
        },
        paste = {
            withSlot {
                val uri = clipboardImageUri(context)
                if (uri != null) viewModel.addImages(listOf(uri), filename = "pasted.jpg") else viewModel.onClipboardEmpty()
            }
        }
    )
}

private fun clipboardImageUri(context: Context): Uri? {
    val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return null
    val clip = clipboard.primaryClip ?: return null
    return (0 until clip.itemCount)
        .mapNotNull { clip.getItemAt(it).uri }
        .firstOrNull { uri -> context.contentResolver.getType(uri)?.startsWith("image/") == true }
}
