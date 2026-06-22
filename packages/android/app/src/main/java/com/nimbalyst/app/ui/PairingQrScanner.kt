package com.nimbalyst.app.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import androidx.lifecycle.compose.LocalLifecycleOwner

/**
 * Full-screen pairing QR scanner. Mirrors the iOS scanner (QRScannerView /
 * PairingView): a full-bleed camera preview with a centered square viewfinder
 * reticle to frame the QR code, plus overlaid instructions and a Cancel action.
 */
@Composable
fun PairingQrScanner(
    modifier: Modifier = Modifier,
    onScanned: (String) -> Unit,
    onCancel: () -> Unit,
) {
    val context = LocalContext.current
    var hasCameraPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED
        )
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasCameraPermission = granted
    }

    LaunchedEffect(hasCameraPermission) {
        if (!hasCameraPermission) {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black)
    ) {
        if (hasCameraPermission) {
            QrCameraPreview(
                modifier = Modifier.fillMaxSize(),
                onScanned = onScanned
            )

            // Centered viewfinder reticle to frame the QR code (matches iOS: a
            // 250dp rounded square with a white 3dp border at 80% opacity).
            Box(
                modifier = Modifier
                    .align(Alignment.Center)
                    .size(250.dp)
                    .border(
                        width = 3.dp,
                        color = Color.White.copy(alpha = 0.8f),
                        shape = RoundedCornerShape(16.dp)
                    )
            )

            // Instructions overlaid at the top, over a gradient scrim so the text
            // stays legible against a bright camera feed.
            Column(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .fillMaxWidth()
                    .background(
                        Brush.verticalGradient(
                            listOf(Color.Black.copy(alpha = 0.55f), Color.Transparent)
                        )
                    )
                    .statusBarsPadding()
                    .padding(horizontal = 24.dp, vertical = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text(
                    text = "Scan pairing QR",
                    style = MaterialTheme.typography.titleMedium,
                    color = Color.White,
                    textAlign = TextAlign.Center
                )
                Text(
                    text = "Point the camera at the desktop pairing code. Android will import the same payload shape used by iOS.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color.White.copy(alpha = 0.85f),
                    textAlign = TextAlign.Center
                )
            }

            OutlinedButton(
                onClick = onCancel,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .padding(24.dp)
                    .fillMaxWidth(),
                border = BorderStroke(1.dp, Color.White.copy(alpha = 0.7f)),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White)
            ) {
                Text("Cancel")
            }
        } else {
            Column(
                modifier = Modifier
                    .align(Alignment.Center)
                    .fillMaxWidth()
                    .padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                Text(
                    text = "Camera access is required to scan the pairing QR code.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color.White,
                    textAlign = TextAlign.Center
                )
                Button(onClick = { permissionLauncher.launch(Manifest.permission.CAMERA) }) {
                    Text("Allow camera")
                }
                // Escape hatch when the user has permanently denied the camera:
                // re-requesting is silently inert, so route them to app settings.
                OutlinedButton(
                    onClick = {
                        val intent = Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.fromParts("package", context.packageName, null)
                        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        context.startActivity(intent)
                    },
                    border = BorderStroke(1.dp, Color.White.copy(alpha = 0.7f)),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White)
                ) {
                    Text("Open settings")
                }
                OutlinedButton(
                    onClick = onCancel,
                    border = BorderStroke(1.dp, Color.White.copy(alpha = 0.7f)),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White)
                ) {
                    Text("Cancel")
                }
            }
        }
    }
}

@Composable
private fun QrCameraPreview(
    modifier: Modifier,
    onScanned: (String) -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val previewView = remember(context) {
        PreviewView(context).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            // Fill the screen and crop (matches iOS resizeAspectFill) so the
            // preview is full-bleed rather than letterboxed.
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
    }

    DisposableEffect(lifecycleOwner, previewView) {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
        val executor = Executors.newSingleThreadExecutor()
        val scanner = BarcodeScanning.getClient()
        val handled = AtomicBoolean(false)

        // Target ~720p: CameraX's default ImageAnalysis resolution (~480p) is too
        // low for reliable QR detection on some devices (iOS uses .high for the
        // same reason). Fall back to the closest available resolution.
        val resolutionSelector = ResolutionSelector.Builder()
            .setResolutionStrategy(
                ResolutionStrategy(
                    Size(1280, 720),
                    ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER
                )
            )
            .build()

        // Bind off the main thread's critical path: addListener fires on the main
        // executor once the provider is ready, instead of blocking on .get().
        var boundProvider: ProcessCameraProvider? = null
        var boundAnalysis: ImageAnalysis? = null
        var disposed = false

        cameraProviderFuture.addListener({
            if (disposed) return@addListener
            val cameraProvider = cameraProviderFuture.get()
            boundProvider = cameraProvider

            val preview = Preview.Builder().build().also { useCase ->
                useCase.surfaceProvider = previewView.surfaceProvider
            }
            val analysis = ImageAnalysis.Builder()
                .setResolutionSelector(resolutionSelector)
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
                .also { useCase ->
                    useCase.setAnalyzer(executor) { imageProxy ->
                        val mediaImage = imageProxy.image
                        if (mediaImage == null || handled.get()) {
                            imageProxy.close()
                            return@setAnalyzer
                        }

                        val inputImage = InputImage.fromMediaImage(
                            mediaImage,
                            imageProxy.imageInfo.rotationDegrees
                        )
                        // Note: ML Kit scans the full frame (no rectOfInterest), so a
                        // QR detected outside the reticle still pairs. The reticle is
                        // an aiming guide; full-frame scanning is the more forgiving UX.
                        scanner.process(inputImage)
                            .addOnSuccessListener { barcodes ->
                                if (handled.get()) {
                                    return@addOnSuccessListener
                                }
                                val rawValue = barcodes.firstNotNullOfOrNull { barcode ->
                                    barcode.rawValue?.takeIf {
                                        barcode.format == Barcode.FORMAT_QR_CODE && it.isNotBlank()
                                    }
                                }
                                if (rawValue != null && handled.compareAndSet(false, true)) {
                                    onScanned(rawValue)
                                }
                            }
                            .addOnCompleteListener {
                                imageProxy.close()
                            }
                    }
                }
            boundAnalysis = analysis

            cameraProvider.unbindAll()
            cameraProvider.bindToLifecycle(
                lifecycleOwner,
                CameraSelector.DEFAULT_BACK_CAMERA,
                preview,
                analysis
            )
        }, ContextCompat.getMainExecutor(context))

        onDispose {
            disposed = true
            boundAnalysis?.clearAnalyzer()
            boundProvider?.unbindAll()
            scanner.close()
            executor.shutdown()
        }
    }

    AndroidView(
        modifier = modifier.semantics { contentDescription = "Pairing QR camera viewfinder" },
        factory = { previewView }
    )
}
