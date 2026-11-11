import type { FileWorkflowGroup } from '@photoallisai/contracts';

export type Photo = {
  workflow?: FileWorkflowGroup;
  workflowConflict?: boolean;
  id: string;
  folderId?: string;
  relativePath?: string;
  modifiedAt?: number;
  sizeBytes?: number;
  width?: number;
  height?: number;
  fileName: string;
  src: string;
  originalSrc?: string;
  temporary?: boolean;
  thumbnailSrc?: string;
  format: string;
  dimensions: string;
  rating: number;
  labelColor?: 'red' | 'yellow' | 'green' | 'blue' | 'purple' | null;
  flag?: 'picked' | 'rejected' | 'unflagged';
  favorite?: boolean;
  tags?: { id: string; name: string }[];
  offline?: boolean;
  status?: 'analyzed' | 'queued' | 'generated';
};

export const photos: Photo[] = [
  {
    id: 'photo-1',
    fileName: 'DSC_4821.NEF',
    src: './demo/portrait.jpg',
    format: 'RAW',
    dimensions: '8256 × 5504',
    rating: 5,
    status: 'generated'
  },
  {
    id: 'photo-2',
    fileName: 'DSC_4837.NEF',
    src: './demo/street.jpg',
    format: 'RAW',
    dimensions: '8256 × 5504',
    rating: 4,
    status: 'analyzed'
  },
  {
    id: 'photo-3',
    fileName: 'A7R_0912.ARW',
    src: './demo/mountain.jpg',
    format: 'RAW',
    dimensions: '9504 × 6336',
    rating: 4
  },
  {
    id: 'photo-4',
    fileName: 'A7R_0938.ARW',
    src: './demo/coast.jpg',
    format: 'RAW',
    dimensions: '9504 × 6336',
    rating: 3,
    status: 'queued'
  },
  {
    id: 'photo-5',
    fileName: 'IMG_7240.HEIC',
    src: './demo/city.jpg',
    format: 'HEIC',
    dimensions: '4032 × 3024',
    rating: 4,
    status: 'analyzed'
  },
  {
    id: 'photo-6',
    fileName: 'GFX_1204.RAF',
    src: './demo/forest.jpg',
    format: 'RAW',
    dimensions: '11648 × 8736',
    rating: 5
  }
];
