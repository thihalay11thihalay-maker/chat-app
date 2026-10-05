import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../../lib/constants';

type VoicePlayerProps = {
  uri: string;
  durationSeconds?: number;
};

export const VoicePlayer = ({ uri, durationSeconds }: VoicePlayerProps) => {
  const player = useAudioPlayer(uri);
  const status = useAudioPlayerStatus(player);
  const [isPlaying, setIsPlaying] = useState(false);

  const togglePlay = () => {
    if (isPlaying) {
      player.pause();
      setIsPlaying(false);
    } else {
      player.play();
      setIsPlaying(true);
    }
  };

  const currentTime = Math.floor(status.currentTime);
  const totalTime = durationSeconds ?? Math.floor(status.duration);

  return (
    <TouchableOpacity style={styles.container} onPress={togglePlay}>
      <View style={styles.playButton}>
        <Ionicons
          name={isPlaying ? 'pause' : 'play'}
          size={20}
          color="white"
        />
      </View>
      <View style={styles.info}>
        <View style={styles.waveform}>
          {Array.from({ length: 20 }).map((_, i) => (
            <View
              key={i}
              style={[
                styles.waveBar,
                {
                  height: 8 + Math.random() * 16,
                  backgroundColor: i < (currentTime / Math.max(totalTime, 1)) * 20
                    ? COLORS.primary
                    : COLORS.border,
                },
              ]}
            />
          ))}
        </View>
        <Text style={styles.time}>
          {currentTime}s / {totalTime}s
        </Text>
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
    minWidth: 180,
  },
  playButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: COLORS.primary,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  info: {
    flex: 1,
  },
  waveform: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 24,
  },
  waveBar: {
    width: 3,
    marginHorizontal: 1,
    borderRadius: 1,
  },
  time: {
    fontSize: 11,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
});

export default VoicePlayer;