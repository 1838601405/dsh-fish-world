import 'package:flutter/material.dart';

import '../theme/whale_tokens.dart';
import 'gallery_image.dart' as impl;

export 'gallery_image.dart' show galleryCanUndo, galleryItemAvailable;

/// 统一缩略图：本地文件 / 桥 URL 都由 impl 决定；失败一律灰底占位，不裂图。
class GalleryThumb extends StatelessWidget {
  final String name;
  final List<String> roots;
  const GalleryThumb({super.key, required this.name, required this.roots});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final provider = impl.galleryProviderFor(name, roots, width: 256);
    if (provider == null) return _placeholder(context, scheme);
    return Image(
      image: provider,
      fit: BoxFit.cover,
      gaplessPlayback: true,
      errorBuilder: (_, __, ___) => _placeholder(context, scheme),
    );
  }

  Widget _placeholder(BuildContext context, ColorScheme scheme) => Container(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.45),
        padding: const EdgeInsets.all(6),
        child: Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.image_outlined, size: 22, color: scheme.onSurfaceVariant),
            const SizedBox(height: 4),
            Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center,
                style: TextStyle(fontSize: WhaleTokens.fsCaption, color: scheme.onSurfaceVariant)),
          ]),
        ),
      );
}

Future<Map<String, dynamic>?> galleryRemove(String name, List<String> roots) =>
    impl.galleryRemove(name, roots);

Future<Map<String, dynamic>?> galleryUndo(String recycled, String name) =>
    impl.galleryUndo(recycled, name);
